import {
  type AppliedMeasure,
  NO_AI,
  type PlanLocale,
  type PlanOptionId,
  type PlanReply,
  STRATEGIES,
  type TurnIntent,
  turnIn,
} from "@flowcarbon/core";
import { schema, type Tx } from "@flowcarbon/db";
import type { BuildingContext } from "@flowcarbon/pipeline";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "./audit";
import type { OrgAccess } from "./auth/access";
import { conflict, notFound, unprocessable } from "./errors";
import {
  agreeMeasure,
  changeMeasureStatus,
  coveredBy,
  holdAdopting,
  setFindings,
  takeEffectIfSimulated,
  userNames,
  userOf,
} from "./measures";
import { iso, uuid } from "./schemas";

export type TurnRow = typeof schema.assistantTurns.$inferSelect;

/** longer than a job and its retries can take, so a turn still pending by then has lost its job */
const TURN_LIMIT_MS = 20 * 60_000;

export const planOptionId = z.enum(["weekends", "weekdays", "balanced", "community"]);
export const dayFigures = z.object({ workday: z.number(), weekend: z.number(), holiday: z.number() });
const planStrategyId = z.enum(["occupancy_gated_workday", "zone_only_non_working", "auto_lights_off"]);

export const planMetricsOut = z.object({
  kwh: z.number(),
  cost: z.number(),
  co2eKg: z.number(),
  avoidableKwh: z.number(),
  avoidableShare: z.number(),
  greenShare: z.number(),
});

export const planOut = z.object({
  window: z.object({ from: z.string(), to: z.string(), days: z.number(), observed: dayFigures }),
  /** the window as the data recorded it */
  recorded: planMetricsOut,
  /** where the building stands, with measures already adopted at their expected saving; options start here */
  before: planMetricsOut,
  /** the avoidable energy those measures answer, before realisation */
  adoptedKwh: z.number(),
  /** the active measures it rests on */
  measureIds: z.array(uuid),
  options: z.array(
    z.object({
      id: planOptionId,
      actions: z.array(
        z.object({
          floorId: uuid,
          strategyId: planStrategyId,
          coveredKwh: z.number(),
          findings: z.number(),
          byDayType: dayFigures,
        }),
      ),
      /** expected, at the middle of the stated range */
      after: planMetricsOut,
      low: planMetricsOut,
      high: planMetricsOut,
      annualSavingKwh: z.number(),
      annualSavingCost: z.number(),
      /** null where the building's currency is not the one the estimate is in */
      capex: z.number().nullable(),
      reachesTarget: z.boolean(),
      /** the target holds at the cautious end of the range too */
      reachesAtLow: z.boolean(),
      shortBy: z.number().nullable(),
    }),
  ),
  /** the share of covered avoidable energy assumed saved, a stated assumption and not a measurement */
  realisation: z.object({ low: z.number(), mid: z.number(), high: z.number() }),
  alreadyMet: z.boolean(),
});

const replyOut = z.object({
  reply: z.string(),
  options: z.array(z.object({ id: planOptionId, title: z.string(), why: z.string() })),
});

const intentOut = z.object({
  kind: z.enum(["plan", "command", "question", "other"]),
  target: z
    .object({ kind: z.enum(["avoidable_share", "avoidable_cut", "energy_cut"]), value: z.number() })
    .nullable(),
  focus: z.enum(["all", "hvac", "lights"]),
  floors: z.array(z.string()),
  unknownFloors: z.array(z.string()),
  /** parts of the building it names, which a plan cannot pick out */
  unknownPlaces: z.array(z.string()).optional(),
  days: z.enum(["all", "weekends", "weekdays"]),
  /** set when no one typed the turn: adopted from the strategies page, or a community strategy tried out */
  source: z.enum(["board", "community"]).optional(),
});

export const turnOut = z.object({
  id: uuid,
  status: z.enum(["pending", "done", "failed"]),
  locale: z.string(),
  prompt: z.string(),
  intent: intentOut.nullable(),
  /** computed from the building's data; every figure the reply shows comes from here */
  plan: planOut.nullable(),
  reply: replyOut.nullable(),
  /** while pending: what has been written so far (partial JSON) */
  draft: z.string().nullable(),
  error: z.string().nullable(),
  /** null when the reply came from a template */
  model: z.string().nullable(),
  requestedBy: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  appliedOption: planOptionId.nullable(),
  appliedAt: z.string().nullable(),
  appliedBy: z.string().nullable(),
  /** the measures it stands on, as they are now and not as they were when it was applied */
  appliedMeasures: z
    .array(
      z.object({
        measureId: uuid,
        floorId: uuid,
        strategyId: z.string(),
        status: z.enum(["planned", "in_effect", "cancelled"]),
        joined: z.boolean(),
        linked: z.number(),
      }),
    )
    .nullable(),
  /** the building's active measures are not the ones this answer counted, so its figures may overlap them */
  outdated: z.boolean(),
});

/**
 * Turns as people see them. A plan is as old as its turn, but what stands on it is told as it is now: an applied option
 * whose measures have all been cancelled is no longer applied, and a turn from before the latest change says so. Asked
 * for another language, a finished turn is told again by the template, over the same figures.
 */
export async function turnsJson(tx: Tx, buildingId: string, turns: readonly TurnRow[], locale?: PlanLocale) {
  const names = await userNames(
    tx,
    turns.flatMap((t) => [t.requestedBy, t.appliedBy]),
  );
  const ids = turns.flatMap((t) => (t.appliedMeasures ?? []).map((m) => m.measureId));
  const live = new Map(
    (ids.length
      ? await tx
          .select({ id: schema.measures.id, status: schema.measures.status })
          .from(schema.measures)
          .where(inArray(schema.measures.id, ids))
      : []
    ).map((m) => [m.id, m.status]),
  );
  const active = await tx
    .select({ id: schema.measures.id })
    .from(schema.measures)
    .where(
      and(
        eq(schema.measures.buildingId, buildingId),
        inArray(schema.measures.status, ["planned", "in_effect"]),
      ),
    );
  const current = new Set(active.map((m) => m.id));
  const changedSince = ({ measureIds }: NonNullable<TurnRow["plan"]>) =>
    measureIds.length !== current.size || measureIds.some((id) => !current.has(id));
  const foreign = (t: TurnRow) => !!locale && t.status === "done" && t.locale !== locale;
  const floors = turns.some(foreign)
    ? await tx
        .select({ id: schema.floors.id, label: schema.floors.label })
        .from(schema.floors)
        .where(eq(schema.floors.buildingId, buildingId))
    : [];

  return turns.map((t) => {
    const measures = (t.appliedMeasures ?? []).map((m) => ({
      ...m,
      status: live.get(m.measureId) ?? ("cancelled" as const),
    }));
    const standing = measures.some((m) => m.status !== "cancelled");
    const told = foreign(t) ? turnIn(t, { locale: locale!, floors }) : t;
    return {
      id: t.id,
      status: t.status,
      locale: foreign(t) ? locale! : t.locale,
      prompt: told.prompt,
      intent: t.intent,
      plan: t.plan,
      reply: told.reply,
      draft: t.status === "pending" ? t.draft : null,
      error: t.error,
      model: foreign(t) ? null : t.model,
      requestedBy: t.requestedBy ? (names.get(t.requestedBy) ?? null) : null,
      createdAt: t.createdAt.toISOString(),
      completedAt: iso(t.completedAt),
      appliedOption: standing ? (t.appliedOption as PlanOptionId | null) : null,
      appliedAt: standing ? iso(t.appliedAt) : null,
      appliedBy: standing && t.appliedBy ? (names.get(t.appliedBy) ?? null) : null,
      appliedMeasures: standing ? measures : null,
      outdated: !standing && !!t.plan && changedSince(t.plan),
    };
  });
}

export const turnJson = async (tx: Tx, buildingId: string, turn: TurnRow, locale?: PlanLocale) =>
  (await turnsJson(tx, buildingId, [turn], locale))[0]!;

/** Ends turns that lost their job, so nothing waits on them and they stop counting against the quota. */
export async function settleLostTurns(tx: Tx, turns: readonly TurnRow[]): Promise<TurnRow[]> {
  const limit = Date.now() - TURN_LIMIT_MS;
  const lost = turns.filter((t) => t.status === "pending" && t.createdAt.getTime() < limit).map((t) => t.id);
  if (!lost.length) return [...turns];
  const ended = await tx
    .update(schema.assistantTurns)
    .set({
      status: "failed",
      draft: null,
      error: "The assistant could not answer; try again later.",
      completedAt: new Date(),
    })
    .where(and(inArray(schema.assistantTurns.id, lost), eq(schema.assistantTurns.status, "pending")))
    .returning();
  const byId = new Map(ended.map((t) => [t.id, t]));
  return turns.map((t) => byId.get(t.id) ?? t);
}

/** A turn no model is asked about: done from the start, and not counted against the AI quota. */
export async function templateTurn(
  tx: Tx,
  access: OrgAccess,
  ctx: BuildingContext,
  values: Pick<TurnRow, "prompt" | "plan"> & {
    locale: PlanLocale;
    intent: TurnIntent;
    reply: PlanReply;
  },
) {
  const [turn] = await tx
    .insert(schema.assistantTurns)
    .values({
      ...values,
      orgId: access.orgId,
      buildingId: ctx.building.id,
      requestedBy: userOf(access),
      status: "done",
      promptVersion: NO_AI,
      completedAt: new Date(),
    })
    .returning();
  return turn!;
}

/** The turn, locked: applying and undoing the same turn wait for each other, so each runs once. */
async function lockTurn(tx: Tx, access: OrgAccess, ctx: BuildingContext, turnId: string) {
  const [turn] = await tx
    .select()
    .from(schema.assistantTurns)
    .where(
      and(
        eq(schema.assistantTurns.id, turnId),
        eq(schema.assistantTurns.orgId, access.orgId),
        eq(schema.assistantTurns.buildingId, ctx.building.id),
      ),
    )
    .for("update");
  if (!turn) throw notFound("Turn");
  return turn;
}

/** Whether any measure a turn applied is still planned or in effect. */
async function stillStanding(tx: Tx, ctx: BuildingContext, turn: TurnRow) {
  const ids = (turn.appliedMeasures ?? []).map((m) => m.measureId);
  if (!ids.length) return false;
  const rows = await tx
    .select({ id: schema.measures.id })
    .from(schema.measures)
    .where(
      and(
        eq(schema.measures.buildingId, ctx.building.id),
        inArray(schema.measures.id, ids),
        inArray(schema.measures.status, ["planned", "in_effect"]),
      ),
    );
  return rows.length > 0;
}

/**
 * The count of uses orders every organisation's list, so it stands for organisations that took a strategy up: one
 * count each, whatever they undo and apply again, and none from the organisation that published it.
 */
async function countsAsUse(tx: Tx, access: OrgAccess, intent: TurnIntent) {
  const [row] = await tx
    .select({ orgId: schema.communityStrategies.orgId })
    .from(schema.communityStrategies)
    .where(eq(schema.communityStrategies.id, intent.communityId!));
  if (!row || row.orgId === access.orgId) return false;
  const [counted] = await tx
    .select({ id: schema.assistantTurns.id })
    .from(schema.assistantTurns)
    .where(
      and(
        eq(schema.assistantTurns.orgId, access.orgId),
        sql`${schema.assistantTurns.intent}->>'communityId' = ${intent.communityId}`,
        sql`${schema.assistantTurns.intent}->>'usesCounted' = 'true'`,
      ),
    )
    .limit(1);
  return !counted;
}

/**
 * Creates the measures of a turn's option, through the same path as adopting a finding, so everything after it (status,
 * verification, the measures page) sees nothing special. In a demo organisation the simulated hardware obeys, so they
 * take effect at once; elsewhere they are planned until someone reports the change as made. Applying the same option
 * again changes nothing.
 */
export async function applyTurn(
  tx: Tx,
  req: FastifyRequest,
  access: OrgAccess,
  ctx: BuildingContext,
  turnId: string,
  optionId: PlanOptionId,
): Promise<TurnRow> {
  await holdAdopting(tx, ctx.building.id);
  const turn = await lockTurn(tx, access, ctx, turnId);
  // measures cancelled since then took the option with them, so it can be applied afresh
  if (turn.appliedOption && (await stillStanding(tx, ctx, turn))) {
    if (turn.appliedOption === optionId) return turn;
    throw conflict("Another option of this turn is applied. Undo it first.", "turn_other_applied");
  }
  if (turn.status !== "done" || !turn.plan) throw conflict("This turn has no plan to apply.", "turn_no_plan");
  const option = turn.plan.options.find((o) => o.id === optionId);
  if (!option) throw unprocessable("This turn has no such option.", undefined, "turn_no_option");

  const applied: AppliedMeasure[] = [];
  for (const { floorId, strategyId } of option.actions) {
    const covered = { floorId, strategyId, originRuleId: STRATEGIES[strategyId].covers[0]!.rule };
    const [origin] = await tx
      .select({
        id: schema.findings.id,
        floorId: schema.findings.floorId,
        ruleId: schema.findings.ruleId,
      })
      .from(schema.findings)
      .where(
        and(
          eq(schema.findings.buildingId, ctx.building.id),
          eq(schema.findings.status, "open"),
          isNull(schema.findings.measureId),
          coveredBy(covered),
        ),
      )
      .orderBy(desc(schema.findings.avoidableKwh), desc(schema.findings.startAt))
      .limit(1);
    // the plan is as old as the turn: someone may have dealt with these findings since
    if (!origin) continue;
    const agreed = await agreeMeasure(tx, req, access, ctx.building.id, {
      finding: origin,
      strategyId,
      source: "ai",
      similar: true,
    });
    const { linked, joined } = agreed;
    const after = await takeEffectIfSimulated(tx, req, access, agreed);
    applied.push({
      measureId: after.id,
      floorId,
      strategyId,
      status: after.status as AppliedMeasure["status"],
      joined,
      linked: linked.length,
      ...(joined ? { findingIds: linked } : {}),
    });
  }
  if (!applied.length)
    throw conflict("Nothing is left to apply: these findings have been dealt with.", "turn_nothing_left");

  const intent = turn.intent;
  const counts = !!intent?.communityId && !intent.usesCounted && (await countsAsUse(tx, access, intent));
  if (counts) await tx.execute(sql`select community_strategy_used(${intent.communityId}::uuid)`);
  const [row] = await tx
    .update(schema.assistantTurns)
    .set({
      appliedOption: optionId,
      appliedAt: new Date(),
      appliedBy: userOf(access),
      appliedMeasures: applied,
      ...(counts ? { intent: { ...intent, usesCounted: true } } : {}),
    })
    .where(eq(schema.assistantTurns.id, turn.id))
    .returning();
  await audit(tx, req, access, {
    action: "assistant.apply",
    entityType: "assistant_turn",
    entityId: turn.id,
    data: { option: optionId, measures: applied.length },
  });
  return row!;
}

/**
 * Takes back what applying created: its measures are cancelled, which reopens their findings, and a measure that was
 * already there only gives back the findings it gained. Undoing what is not applied changes nothing.
 */
export async function undoTurn(
  tx: Tx,
  req: FastifyRequest,
  access: OrgAccess,
  ctx: BuildingContext,
  turnId: string,
): Promise<TurnRow> {
  const turn = await lockTurn(tx, access, ctx, turnId);
  if (!turn.appliedOption) return turn;
  const applied = turn.appliedMeasures ?? [];
  const measures = await tx
    .select()
    .from(schema.measures)
    .where(
      and(
        eq(schema.measures.buildingId, ctx.building.id),
        inArray(
          schema.measures.id,
          applied.map((a) => a.measureId),
        ),
      ),
    );
  for (const a of applied) {
    const m = measures.find((x) => x.id === a.measureId);
    // someone cancelled it in the meantime: nothing left to take back
    if (!m || m.status === "cancelled") continue;
    if (!a.joined) {
      await changeMeasureStatus(tx, req, access, m, "cancelled");
      continue;
    }
    const still = await tx
      .select({ id: schema.findings.id })
      .from(schema.findings)
      .where(and(eq(schema.findings.measureId, m.id), inArray(schema.findings.id, a.findingIds ?? [])));
    const given = await setFindings(
      tx,
      access,
      still.map((f) => f.id),
      { status: "open", measureId: null },
    );
    // the measure stays, so its own history has to say what left it
    await audit(tx, req, access, {
      action: "measure.leave",
      entityType: "measure",
      entityId: m.id,
      data: { turnId: turn.id, strategyId: m.strategyId, findings: given },
    });
  }
  const [row] = await tx
    .update(schema.assistantTurns)
    .set({ appliedOption: null, appliedAt: null, appliedBy: null, appliedMeasures: null })
    .where(eq(schema.assistantTurns.id, turn.id))
    .returning();
  await audit(tx, req, access, {
    action: "assistant.undo",
    entityType: "assistant_turn",
    entityId: turn.id,
    data: { option: turn.appliedOption, measures: applied.map((a) => a.measureId) },
  });
  return row!;
}
