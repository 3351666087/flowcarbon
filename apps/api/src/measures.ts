import {
  Calendar,
  type DayType,
  DEFAULT_ANNUAL_DAYS,
  localParts,
  type MeasureStrategyId,
  measureCovers,
  type RuleId,
  zonedTime,
} from "@flowcarbon/core";
import { schema, type Tx } from "@flowcarbon/db";
import type { BuildingContext } from "@flowcarbon/pipeline";
import { and, eq, gte, inArray, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { addDaysKey } from "./routes/helpers";
import { iso, uuid } from "./schemas";

export type MeasureRow = typeof schema.measures.$inferSelect;

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
  /** complete covered days since it took effect; null until it has */
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
  /** expected (not yet in effect) or measured saving per week */
  weekly: z.object({ kwh: z.number(), cost: z.number() }),
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

const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * Whether a measure works, from the data: the covered avoidable energy per covered day in the BEFORE_DAYS before it
 * took effect against the complete covered days since. A measure not yet in effect gets the saving its last
 * BEFORE_DAYS suggest.
 */
export async function verify(
  tx: Tx,
  ctx: BuildingContext,
  m: MeasureRow,
  now = Date.now(),
): Promise<z.infer<typeof verificationOut>> {
  const tz = ctx.building.timezone;
  const cal = new Calendar(ctx.building.calendar);
  const types = [...new Set(coverage(m).flatMap((c) => c.dayTypes))] as DayType[];
  const today = localParts(now, tz).dateKey;
  const changedAt = m.status !== "planned" ? (m.implementedAt?.getTime() ?? null) : null;
  const pivot = changedAt === null ? today : localParts(changedAt, tz).dateKey;
  const first = addDaysKey(pivot, -BEFORE_DAYS);

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
  for (let d = first; d <= today; d = addDaysKey(d, 1)) {
    const t = cal.dayType(d);
    const covered = types.includes(t);
    const v = byDay.get(d) ?? { kwh: 0, cost: 0 };
    const phase = d < pivot ? "before" : d === pivot && changedAt !== null ? "change" : "after";
    const complete = d < today;
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

  let verdict: z.infer<typeof verificationOut>["verdict"] = "projected";
  let saved = { kwh: beforeOut.perDayKwh, cost: beforeOut.perDayCost };
  if (afterOut) {
    saved = {
      kwh: Math.max(0, beforeOut.perDayKwh - afterOut.perDayKwh),
      cost: Math.max(0, beforeOut.perDayCost - afterOut.perDayCost),
    };
    if (afterOut.days === 0) verdict = "waiting";
    else if (afterOut.perDayKwh <= Math.max(0.1 * beforeOut.perDayKwh, 1)) verdict = "working";
    else if (afterOut.perDayKwh < 0.6 * beforeOut.perDayKwh) verdict = "partly";
    else verdict = "not_working";
    if (verdict === "waiting") saved = { kwh: beforeOut.perDayKwh, cost: beforeOut.perDayCost };
  }
  return {
    dayTypes: types,
    series,
    before: beforeOut,
    after: afterOut,
    weekly: { kwh: round(saved.kwh * daysPerWeek), cost: round(saved.cost * daysPerWeek, 2) },
    verdict,
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

export async function measureJson(tx: Tx, ctx: BuildingContext, m: MeasureRow): Promise<MeasureJson> {
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
    verification: await verify(tx, ctx, m),
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
