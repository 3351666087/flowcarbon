import {
  Calendar,
  type DayType,
  DEFAULT_ANNUAL_DAYS,
  localParts,
  type MeasureStrategyId,
  measureCovers,
  REALISATION,
  type RuleId,
  zonedTime,
} from "@flowcarbon/core";
import { schema, type Tx } from "@flowcarbon/db";
import { type BuildingContext, type MeasureFooting, measureFooting } from "@flowcarbon/pipeline";
import { and, desc, eq, gte, inArray, isNull, lt, ne, or, type SQL, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { audit } from "./audit";
import type { OrgAccess } from "./auth/access";
import { addDaysKey } from "./routes/helpers";
import { iso, uuid } from "./schemas";

export type MeasureRow = typeof schema.measures.$inferSelect;
type MeasureStatus = MeasureRow["status"];
type FindingRow = typeof schema.findings.$inferSelect;

export const userOf = (access: OrgAccess) => (access.actor.type === "user" ? access.actor.id : null);

/** days before a measure (or before today, for one not yet in effect) that its effect is measured against */
export const BEFORE_DAYS = 14;

const dayType = z.enum(["workday", "weekend", "holiday"]);
export const verificationOut = z.object({
  /** the kinds of day the measure acts on */
  dayTypes: z.array(dayType),
  /** covered avoidable energy per local day, from BEFORE_DAYS before the change to today */
  series: z.array(
    z.object({
      date: z.string(),
      dayType,
      covered: z.boolean(),
      phase: z.enum(["before", "change", "after"]),
      /** a whole day of data is in: a day without one says nothing about the waste, however quiet it looks */
      complete: z.boolean(),
      kwh: z.number(),
      cost: z.number(),
    }),
  ),
  before: z.object({
    days: z.number(),
    kwh: z.number(),
    cost: z.number(),
    perDayKwh: z.number(),
    perDayCost: z.number(),
  }),
  /** covered days since it took effect that have a complete day of data; null until it has taken effect */
  after: z
    .object({
      days: z.number(),
      kwh: z.number(),
      cost: z.number(),
      perDayKwh: z.number(),
      perDayCost: z.number(),
      /** covered findings that started after it took effect */
      recurrences: z.number(),
      lastAt: z.string().nullable(),
    })
    .nullable(),
  /** expected (not measured yet) or measured saving per week */
  weekly: z.object({ kwh: z.number(), cost: z.number() }),
  /** what an expected `weekly` stands on and the range around it, as on the plan it came from; null once it is measured */
  expected: z
    .object({
      days: z.number(),
      lowKwh: z.number(),
      highKwh: z.number(),
      realisation: z.object({ low: z.number(), mid: z.number(), high: z.number() }),
    })
    .nullable(),
  verdict: z.enum(["projected", "waiting", "working", "partly", "not_working"]),
});

export const measureOut = z.object({
  id: uuid,
  floorId: uuid,
  floorLabel: z.string(),
  strategyId: z.string(),
  note: z.string().nullable(),
  source: z.enum(["ai", "ai_edited", "manual"]),
  status: z.enum(["planned", "in_effect", "cancelled"]),
  originFindingId: uuid.nullable(),
  originRuleId: z.string(),
  explanationId: uuid.nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  implementedAt: z.string().nullable(),
  implementedBy: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  /** linked findings by status */
  findings: z.object({ total: z.number(), acknowledged: z.number(), fixed: z.number() }),
  verification: verificationOut,
});
export type MeasureJson = z.infer<typeof measureOut>;

export const activityOut = z.object({
  at: z.string(),
  action: z.string(),
  actor: z.string().nullable(),
  data: z.record(z.string(), z.unknown()).nullable(),
});

export function coverage(m: Pick<MeasureRow, "strategyId" | "originRuleId">) {
  return measureCovers(m.strategyId as MeasureStrategyId, m.originRuleId as RuleId);
}

/** Findings of the kinds a measure answers, on its floor. */
export function coveredBy(m: Pick<MeasureRow, "floorId" | "strategyId" | "originRuleId">): SQL {
  return and(
    eq(schema.findings.floorId, m.floorId),
    or(
      ...coverage(m).map((c) =>
        and(eq(schema.findings.ruleId, c.rule), inArray(schema.findings.dayType, c.dayTypes)),
      ),
    ),
  )!;
}

/** Sets the status of findings linked to a measure (and, with `measureId`, links them first). */
export async function setFindings(
  tx: Tx,
  access: OrgAccess,
  ids: string[],
  set: { status: "open" | "acknowledged" | "fixed"; measureId: string | null },
) {
  if (!ids.length) return 0;
  await tx
    .update(schema.findings)
    .set({ ...set, statusBy: userOf(access), statusAt: new Date(), statusNote: null })
    .where(inArray(schema.findings.id, ids));
  return ids.length;
}

export interface MeasureAgreement {
  /** the finding it is agreed from */
  finding: Pick<FindingRow, "id" | "floorId" | "ruleId">;
  strategyId: MeasureStrategyId;
  source: MeasureRow["source"];
  note?: string | null;
  explanationId?: string | null;
  /** link the floor's other open findings it covers too */
  similar: boolean;
}

/**
 * Holds adopting on a building until the transaction ends. Looking for a floor's measure and then creating it are two
 * steps, so two people adopting at once would each find nothing and each create one. Held per building, not per floor,
 * so that two options touching the same floors in a different order cannot deadlock.
 */
export const holdAdopting = (tx: Tx, buildingId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`adopting:${buildingId}`}, 0))`);

/**
 * Agrees a measure for a finding, or joins the floor's active measure with the same strategy, and links the findings.
 * Every way of adopting a strategy comes through here. The caller has checked the finding is free to take.
 */
export async function agreeMeasure(
  tx: Tx,
  req: FastifyRequest,
  access: OrgAccess,
  buildingId: string,
  agreement: MeasureAgreement,
) {
  const { finding: f, strategyId, source } = agreement;
  await holdAdopting(tx, buildingId);
  // one active measure per floor and strategy: a second finding joins it
  const [existing] = await tx
    .select()
    .from(schema.measures)
    .where(
      and(
        eq(schema.measures.floorId, f.floorId),
        eq(schema.measures.strategyId, strategyId),
        inArray(schema.measures.status, ["planned", "in_effect"]),
        strategyId === "investigate_on_site" ? eq(schema.measures.originRuleId, f.ruleId) : undefined,
      ),
    );
  const m =
    existing ??
    (
      await tx
        .insert(schema.measures)
        .values({
          orgId: access.orgId,
          buildingId,
          floorId: f.floorId,
          strategyId,
          note: agreement.note || null,
          source,
          explanationId: agreement.explanationId ?? null,
          originFindingId: f.id,
          originRuleId: f.ruleId,
          createdBy: userOf(access),
        })
        .returning()
    )[0]!;
  const ids = [f.id];
  if (agreement.similar) {
    const similar = await tx
      .select({ id: schema.findings.id })
      .from(schema.findings)
      .where(
        and(
          eq(schema.findings.buildingId, buildingId),
          eq(schema.findings.status, "open"),
          isNull(schema.findings.measureId),
          ne(schema.findings.id, f.id),
          coveredBy(m),
        ),
      );
    ids.push(...similar.map((s) => s.id));
  }
  await setFindings(tx, access, ids, {
    status: m.status === "in_effect" ? "fixed" : "acknowledged",
    measureId: m.id,
  });
  await audit(tx, req, access, {
    action: existing ? "measure.join" : "measure.create",
    entityType: "measure",
    entityId: m.id,
    data: { findingId: f.id, strategyId: m.strategyId, source, linked: ids.length },
  });
  return { measure: m, linked: ids, joined: !!existing };
}

/**
 * In a demo organisation the simulated hardware obeys, so a new measure takes effect as it is agreed, whichever way it
 * was adopted; elsewhere it stays planned until someone reports the change as made. One that was already there is
 * left as its people left it.
 */
export async function takeEffectIfSimulated(
  tx: Tx,
  req: FastifyRequest,
  access: OrgAccess,
  agreed: { measure: MeasureRow; joined: boolean },
) {
  const { measure, joined } = agreed;
  if (joined) return measure;
  const [org] = await tx
    .select({ plan: schema.organizations.plan })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, access.orgId));
  return org?.plan === "demo" ? changeMeasureStatus(tx, req, access, measure, "in_effect") : measure;
}

/** The columns a change of status touches; nothing when the change is not one a measure can make. */
export function statusChange(
  from: MeasureStatus,
  to: MeasureStatus | undefined,
  user: string | null,
  now: Date,
) {
  if (to === "in_effect" && from === "planned")
    return { status: "in_effect" as const, implementedAt: now, implementedBy: user };
  if (to === "planned" && from === "in_effect")
    return { status: "planned" as const, implementedAt: null, implementedBy: null };
  if (to === "cancelled") return { status: "cancelled" as const, cancelledAt: now, cancelledBy: user };
  return {};
}

/**
 * What a measure's new status does to its findings. In effect resolves them, and the floor's earlier open ones of the
 * same kinds, which are the problem it solved; back to planned undoes that; cancelled reopens them.
 */
export async function settleFindings(
  tx: Tx,
  access: OrgAccess,
  buildingId: string,
  after: MeasureRow,
  now: Date,
): Promise<{ action: string; count: number }> {
  const linked = (status: "acknowledged" | "fixed") =>
    tx
      .select({ id: schema.findings.id })
      .from(schema.findings)
      .where(and(eq(schema.findings.measureId, after.id), eq(schema.findings.status, status)))
      .then((rows) => rows.map((r) => r.id));
  if (after.status === "in_effect") {
    const earlier = await tx
      .select({ id: schema.findings.id })
      .from(schema.findings)
      .where(
        and(
          eq(schema.findings.buildingId, buildingId),
          eq(schema.findings.status, "open"),
          isNull(schema.findings.measureId),
          lt(schema.findings.startAt, now),
          coveredBy(after),
        ),
      );
    const ids = [...(await linked("acknowledged")), ...earlier.map((r) => r.id)];
    const count = await setFindings(tx, access, ids, { status: "fixed", measureId: after.id });
    return { action: "measure.implement", count };
  }
  if (after.status === "planned") {
    const ids = await linked("fixed");
    const count = await setFindings(tx, access, ids, { status: "acknowledged", measureId: after.id });
    return { action: "measure.unimplement", count };
  }
  const ids = [...(await linked("acknowledged")), ...(await linked("fixed"))];
  return {
    action: "measure.cancel",
    count: await setFindings(tx, access, ids, { status: "open", measureId: null }),
  };
}

/** Moves a measure to a new status and its findings with it, recording that in the audit log. */
export async function changeMeasureStatus(
  tx: Tx,
  req: FastifyRequest,
  access: OrgAccess,
  before: MeasureRow,
  status: MeasureStatus,
) {
  const now = new Date();
  const [after] = await tx
    .update(schema.measures)
    .set(statusChange(before.status, status, userOf(access), now))
    .where(eq(schema.measures.id, before.id))
    .returning();
  const { action, count } = await settleFindings(tx, access, before.buildingId, after!, now);
  await audit(tx, req, access, {
    action,
    entityType: "measure",
    entityId: before.id,
    data: { status: { from: before.status, to: after!.status }, findings: count },
  });
  return after!;
}

const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * Whether a measure works, from the data: the covered avoidable energy per covered day in the BEFORE_DAYS before it
 * took effect against the complete covered days since. Until that says something, its figure is the one its plan gave,
 * a week at a time and with the same range, so a building whose data ended still has one. Only days with data count: no
 * findings on a day without any is not a day without waste.
 */
export async function verify(
  tx: Tx,
  ctx: BuildingContext,
  m: MeasureRow,
  now = Date.now(),
  footing?: MeasureFooting,
): Promise<z.infer<typeof verificationOut>> {
  const tz = ctx.building.timezone;
  const cal = new Calendar(ctx.building.calendar);
  const types = [...new Set(coverage(m).flatMap((c) => c.dayTypes))] as DayType[];
  const today = localParts(now, tz).dateKey;
  const changedAt = m.status !== "planned" ? (m.implementedAt?.getTime() ?? null) : null;
  const changed = changedAt === null ? null : localParts(changedAt, tz).dateKey;
  const [latest] = await tx
    .select({ day: schema.floorDaily.day })
    .from(schema.floorDaily)
    .where(eq(schema.floorDaily.floorId, m.floorId))
    .orderBy(desc(schema.floorDaily.day))
    .limit(1);
  // today is still coming in, so the data runs up to it at most
  const dataEnd = latest && latest.day < today ? addDaysKey(latest.day, 1) : today;
  const pivot = changed !== null && changed < dataEnd ? changed : dataEnd;
  const first = addDaysKey(pivot, -BEFORE_DAYS);
  const days = await tx
    .select({ day: schema.floorDaily.day })
    .from(schema.floorDaily)
    .where(and(eq(schema.floorDaily.floorId, m.floorId), gte(schema.floorDaily.day, first)));
  const withData = new Set(days.map((d) => d.day));

  const rows = await tx
    .select({
      startAt: schema.findings.startAt,
      kwh: schema.findings.avoidableKwh,
      cost: schema.findings.avoidableCost,
    })
    .from(schema.findings)
    .where(
      and(
        eq(schema.findings.buildingId, m.buildingId),
        coveredBy(m),
        gte(schema.findings.startAt, new Date(zonedTime(first, 0, tz))),
      ),
    );
  const byDay = new Map<string, { kwh: number; cost: number }>();
  let recurrences = 0;
  let lastAt: number | null = null;
  for (const r of rows) {
    const day = localParts(r.startAt.getTime(), tz).dateKey;
    const v = byDay.get(day) ?? { kwh: 0, cost: 0 };
    v.kwh += r.kwh;
    v.cost += r.cost;
    byDay.set(day, v);
    if (changedAt !== null && r.startAt.getTime() >= changedAt) {
      recurrences++;
      lastAt = Math.max(lastAt ?? 0, r.startAt.getTime());
    }
  }

  const series: z.infer<typeof verificationOut>["series"] = [];
  const before = { days: 0, kwh: 0, cost: 0 };
  const after = { days: 0, kwh: 0, cost: 0 };
  // a building whose data ended stops there, not at a today it has nothing to say about
  const lastShown = dataEnd < today ? addDaysKey(dataEnd, -1) : today;
  for (let d = first; d <= lastShown; d = addDaysKey(d, 1)) {
    const t = cal.dayType(d);
    const covered = types.includes(t);
    const v = byDay.get(d) ?? { kwh: 0, cost: 0 };
    const phase = d < pivot ? "before" : d === changed ? "change" : "after";
    const complete = d < today && withData.has(d);
    series.push({ date: d, dayType: t, covered, phase, complete, kwh: round(v.kwh), cost: round(v.cost, 2) });
    if (!covered || !complete) continue;
    const bucket = phase === "before" ? before : phase === "after" && changedAt !== null ? after : null;
    if (!bucket) continue;
    bucket.days++;
    bucket.kwh += v.kwh;
    bucket.cost += v.cost;
  }
  const per = (b: { days: number; kwh: number; cost: number }) => ({
    days: b.days,
    kwh: round(b.kwh),
    cost: round(b.cost, 2),
    perDayKwh: round(b.days ? b.kwh / b.days : 0),
    perDayCost: round(b.days ? b.cost / b.days : 0, 2),
  });
  const beforeOut = per(before);
  const afterOut =
    changedAt === null
      ? null
      : { ...per(after), recurrences, lastAt: iso(lastAt === null ? null : new Date(lastAt)) };
  const daysPerWeek = types.reduce((s, t) => s + DEFAULT_ANNUAL_DAYS[t], 0) / 52;

  const common = { dayTypes: types, series, before: beforeOut, after: afterOut };
  if (!afterOut?.days) {
    const basis = footing ?? (await measureFooting(tx, ctx, now));
    const { kwh, cost, lowKwh, highKwh } = basis.expected({
      ...m,
      strategyId: m.strategyId as MeasureStrategyId,
      originRuleId: m.originRuleId as RuleId,
    });
    return {
      ...common,
      weekly: { kwh, cost },
      expected: { days: basis.days, lowKwh, highKwh, realisation: REALISATION },
      verdict: afterOut ? "waiting" : "projected",
    };
  }
  const saved = {
    kwh: Math.max(0, beforeOut.perDayKwh - afterOut.perDayKwh),
    cost: Math.max(0, beforeOut.perDayCost - afterOut.perDayCost),
  };
  const fallen = afterOut.perDayKwh <= Math.max(0.1 * beforeOut.perDayKwh, 1);
  const halfway = afterOut.perDayKwh < 0.6 * beforeOut.perDayKwh;
  return {
    ...common,
    weekly: { kwh: round(saved.kwh * daysPerWeek), cost: round(saved.cost * daysPerWeek, 2) },
    expected: null,
    verdict: fallen ? "working" : halfway ? "partly" : "not_working",
  };
}

/** Names of the given users, for "who did it" lines. */
export async function userNames(tx: Tx, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map<string, string>();
  const rows = await tx
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(inArray(schema.users.id, wanted));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function measureJson(
  tx: Tx,
  ctx: BuildingContext,
  m: MeasureRow,
  footing?: MeasureFooting,
): Promise<MeasureJson> {
  const counts = await tx
    .select({ status: schema.findings.status, n: sql<number>`count(*)::int` })
    .from(schema.findings)
    .where(eq(schema.findings.measureId, m.id))
    .groupBy(schema.findings.status);
  const n = (s: string) => counts.find((c) => c.status === s)?.n ?? 0;
  const names = await userNames(tx, [m.createdBy, m.implementedBy]);
  return {
    id: m.id,
    floorId: m.floorId,
    floorLabel: ctx.floors.find((f) => f.id === m.floorId)?.label ?? "",
    strategyId: m.strategyId,
    note: m.note,
    source: m.source,
    status: m.status,
    originFindingId: m.originFindingId,
    originRuleId: m.originRuleId,
    explanationId: m.explanationId,
    createdAt: m.createdAt.toISOString(),
    createdBy: m.createdBy ? (names.get(m.createdBy) ?? null) : null,
    implementedAt: iso(m.implementedAt),
    implementedBy: m.implementedBy ? (names.get(m.implementedBy) ?? null) : null,
    cancelledAt: iso(m.cancelledAt),
    findings: {
      total: counts.reduce((s, c) => s + c.n, 0),
      acknowledged: n("acknowledged"),
      fixed: n("fixed"),
    },
    verification: await verify(tx, ctx, m, Date.now(), footing),
  };
}

/** What happened to a finding and the measure it belongs to, oldest first, with who did it. */
export async function activityOf(tx: Tx, findingId: string, measureId: string | null) {
  const rows = await tx
    .select({
      at: schema.auditLog.at,
      action: schema.auditLog.action,
      data: schema.auditLog.data,
      actor: schema.users.name,
    })
    .from(schema.auditLog)
    .leftJoin(schema.users, sql`${schema.users.id}::text = ${schema.auditLog.actorId}`)
    .where(
      or(
        and(eq(schema.auditLog.entityType, "finding"), eq(schema.auditLog.entityId, findingId)),
        measureId
          ? and(eq(schema.auditLog.entityType, "measure"), eq(schema.auditLog.entityId, measureId))
          : undefined,
      ),
    )
    .orderBy(schema.auditLog.at)
    .limit(100);
  return rows.map((r) => ({
    at: r.at.toISOString(),
    action: r.action,
    actor: r.actor,
    data: (r.data as Record<string, unknown> | null) ?? null,
  }));
}
