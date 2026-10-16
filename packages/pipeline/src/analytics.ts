import {
  type AnnualisationBasis,
  type CapexModel,
  type ContractualInstrument,
  type DayType,
  DEFAULT_ANNUAL_DAYS,
  DEFAULT_CAPEX,
  type EnergyReport,
  estimateStrategies,
  type Finding,
  type FloorDayStats,
  forecastFloors,
  RULES,
  type RuleId,
  reportDisclosures,
  round,
  type StrategyEstimate,
  scope2,
  selectFactor,
} from "@flowcarbon/core";
import { schema, type Tx } from "@flowcarbon/db";
import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { type BuildingContext, locationFactorFor } from "./context";
import { addDays, dayWindow } from "./recompute";

const DAY_TYPES: DayType[] = ["workday", "weekend", "holiday"];

/** Rebuilds the next `days` days of headcount forecasts from the last six weeks of roll-ups. */
export async function refreshForecasts(tx: Tx, ctx: BuildingContext, fromDate: string, days = 7) {
  const history = await tx
    .select()
    .from(schema.floorDaily)
    .where(
      and(
        eq(schema.floorDaily.buildingId, ctx.building.id),
        gte(schema.floorDaily.day, addDays(fromDate, -42)),
        lt(schema.floorDaily.day, fromDate),
      ),
    );
  const stats: FloorDayStats[] = history.map((h) => ({
    floorId: h.floorId,
    dateKey: h.day,
    dayType: h.dayType,
    afterHoursPeak: h.afterHoursPeak,
    afterHoursHvacHours: h.afterHoursHvacHours,
    afterHoursKwh: h.kwhAfterHours,
    totalKwh: h.kwhTotal,
  }));
  const fc = forecastFloors(ctx.building, ctx.floors, stats, fromDate, days);
  if (fc.length) {
    await tx
      .insert(schema.forecasts)
      .values(
        fc.map((f) => ({
          orgId: ctx.orgId,
          buildingId: ctx.building.id,
          floorId: f.floorId,
          day: f.dateKey,
          dayType: f.dayType,
          median: f.median,
          low: f.low,
          high: f.high,
          basis: f.basis,
          advice: f.advice,
          method: f.method,
        })),
      )
      .onConflictDoUpdate({
        target: [schema.forecasts.floorId, schema.forecasts.day],
        set: {
          dayType: sql`excluded.day_type`,
          median: sql`excluded.median`,
          low: sql`excluded.low`,
          high: sql`excluded.high`,
          basis: sql`excluded.basis`,
          advice: sql`excluded.advice`,
          method: sql`excluded.method`,
          generatedAt: sql`now()`,
        },
      });
  }
  return fc;
}

async function dayTypeCounts(
  tx: Tx,
  ctx: BuildingContext,
  fromDate: string,
  toDateExclusive: string,
): Promise<Record<DayType, number>> {
  const rows = await tx
    .select({
      dayType: schema.floorDaily.dayType,
      days: sql<number>`count(distinct ${schema.floorDaily.day})::int`,
    })
    .from(schema.floorDaily)
    .where(
      and(
        eq(schema.floorDaily.buildingId, ctx.building.id),
        gte(schema.floorDaily.day, fromDate),
        lt(schema.floorDaily.day, toDateExclusive),
      ),
    )
    .groupBy(schema.floorDaily.dayType);
  const out: Record<DayType, number> = { workday: 0, weekend: 0, holiday: 0 };
  for (const r of rows) out[r.dayType] = r.days;
  return out;
}

async function findingsIn(tx: Tx, ctx: BuildingContext, from: number, to: number): Promise<Finding[]> {
  const rows = await tx
    .select()
    .from(schema.findings)
    .where(
      and(
        eq(schema.findings.buildingId, ctx.building.id),
        gte(schema.findings.startAt, new Date(from)),
        lt(schema.findings.startAt, new Date(to)),
      ),
    );
  return rows.map((r) => ({
    ruleId: r.ruleId as RuleId,
    kind: r.kind,
    floorId: r.floorId,
    start: r.startAt.getTime(),
    end: r.endAt.getTime(),
    dayType: r.dayType,
    avoidableKwh: r.avoidableKwh,
    peakPeople: r.peakPeople,
    tier: r.tier,
    evidence: r.evidence,
  }));
}

export interface StrategySummary {
  window: { from: string; to: string; observed: Record<DayType, number> };
  strategies: StrategyEstimate[];
  capexModel: CapexModel;
}

/** Annual savings per strategy, extrapolated per day type from the findings in [fromDate, toDate). */
export async function strategySummary(
  tx: Tx,
  ctx: BuildingContext,
  fromDate: string,
  toDateExclusive: string,
  annual: Record<DayType, number> = DEFAULT_ANNUAL_DAYS,
  capexModel: CapexModel = DEFAULT_CAPEX,
): Promise<StrategySummary> {
  const { from, to } = dayWindow(ctx.building, fromDate, toDateExclusive);
  const observed = await dayTypeCounts(tx, ctx, fromDate, toDateExclusive);
  const basis: AnnualisationBasis = { observed, annual };
  const findings = await findingsIn(tx, ctx, from, to);
  return {
    window: { from: fromDate, to: toDateExclusive, observed },
    strategies: estimateStrategies(findings, ctx.floors, basis, capexModel),
    capexModel,
  };
}

/** Energy and carbon report for whole local days, computed from daily roll-ups (cheap at any scale). */
export async function buildingReport(
  tx: Tx,
  ctx: BuildingContext,
  fromDate: string,
  toDateExclusive: string,
): Promise<EnergyReport> {
  const { from, to } = dayWindow(ctx.building, fromDate, toDateExclusive);
  const rows = await tx
    .select()
    .from(schema.floorDaily)
    .where(
      and(
        eq(schema.floorDaily.buildingId, ctx.building.id),
        gte(schema.floorDaily.day, fromDate),
        lt(schema.floorDaily.day, toDateExclusive),
      ),
    );
  const year = Number(addDays(toDateExclusive, -1).slice(0, 4));
  const locationFactor = locationFactorFor(ctx, year);
  const residualFactor = selectFactor(
    ctx.factors.filter((f) => f.method === "market"),
    { region: ctx.building.gridRegion, year, method: "market" },
  );
  const instrumentRows = await tx
    .select()
    .from(schema.contractualInstruments)
    .where(
      and(
        eq(schema.contractualInstruments.buildingId, ctx.building.id),
        lte(schema.contractualInstruments.periodStart, addDays(toDateExclusive, -1)),
        gte(schema.contractualInstruments.periodEnd, fromDate),
      ),
    );
  // instruments are prorated to the overlap of their period with the report period
  const instruments: ContractualInstrument[] = instrumentRows.map((r) => {
    const span = (Date.parse(r.periodEnd) - Date.parse(r.periodStart)) / 86_400_000 + 1;
    const overlap =
      (Math.min(Date.parse(r.periodEnd), Date.parse(addDays(toDateExclusive, -1))) -
        Math.max(Date.parse(r.periodStart), Date.parse(fromDate))) /
        86_400_000 +
      1;
    return {
      kind: r.kind,
      kwh: (r.kwh * Math.max(0, overlap)) / span,
      kgPerKwh: r.kgPerKwh,
      description: r.description ?? undefined,
    };
  });

  const labels = new Map(ctx.floors.map((f) => [f.id, f.label]));
  const byFloor = new Map<string, { kwh: number; afterHoursKwh: number; avoidableKwh: number }>();
  const byType = new Map<DayType, { days: Set<string>; kwh: number; avoidableKwh: number }>(
    DAY_TYPES.map((t) => [t, { days: new Set(), kwh: 0, avoidableKwh: 0 }]),
  );
  let kwh = 0;
  let after = 0;
  let cost = 0;
  let measured = 0;
  let avoidable = 0;
  for (const r of rows) {
    kwh += r.kwhTotal;
    after += r.kwhAfterHours;
    cost += r.cost;
    measured += r.kwhMeasured;
    avoidable += r.avoidableKwh;
    const f = byFloor.get(r.floorId) ?? { kwh: 0, afterHoursKwh: 0, avoidableKwh: 0 };
    f.kwh += r.kwhTotal;
    f.afterHoursKwh += r.kwhAfterHours;
    f.avoidableKwh += r.avoidableKwh;
    byFloor.set(r.floorId, f);
    const t = byType.get(r.dayType)!;
    t.days.add(r.day);
    t.kwh += r.kwhTotal;
    t.avoidableKwh += r.avoidableKwh;
  }
  const ruleRows = await tx
    .select({
      ruleId: schema.findings.ruleId,
      count: sql<number>`count(*)::int`,
      kwh: sql<number>`coalesce(sum(${schema.findings.avoidableKwh}), 0)::float8`,
      cost: sql<number>`coalesce(sum(${schema.findings.avoidableCost}), 0)::float8`,
    })
    .from(schema.findings)
    .where(
      and(
        eq(schema.findings.buildingId, ctx.building.id),
        gte(schema.findings.startAt, new Date(from)),
        lt(schema.findings.startAt, new Date(to)),
      ),
    )
    .groupBy(schema.findings.ruleId);
  const avoidableCost = ruleRows.reduce((s, r) => s + r.cost, 0);
  const dayTypes: Record<DayType, number> = { workday: 0, weekend: 0, holiday: 0 };
  for (const [t, v] of byType) dayTypes[t] = v.days.size;

  return {
    period: { from, to, days: dayTypes.workday + dayTypes.weekend + dayTypes.holiday, dayTypes },
    totals: {
      kwh: round(kwh, 1),
      afterHoursKwh: round(after, 1),
      cost: round(cost, 2),
      avoidableKwh: round(avoidable, 1),
      avoidableCost: round(avoidableCost, 2),
      avoidableShare: kwh > 0 ? avoidable / kwh : 0,
      measuredShare: kwh > 0 ? measured / kwh : 0,
    },
    scope2: scope2(kwh, locationFactor, instruments, residualFactor),
    avoidableCo2eKg: round(avoidable * locationFactor.kgPerKwh, 1),
    byFloor: [...byFloor]
      .map(([floorId, v]) => ({
        floorId,
        label: labels.get(floorId) ?? floorId,
        kwh: round(v.kwh, 1),
        afterHoursKwh: round(v.afterHoursKwh, 1),
        avoidableKwh: round(v.avoidableKwh, 1),
      }))
      .sort((a, b) => b.avoidableKwh - a.avoidableKwh),
    byDayType: [...byType].map(([dayType, v]) => ({
      dayType,
      days: v.days.size,
      kwh: round(v.kwh, 1),
      avoidableKwh: round(v.avoidableKwh, 1),
    })),
    byRule: ruleRows.map((r) => {
      const meta = RULES[r.ruleId as RuleId];
      return {
        ruleId: r.ruleId as RuleId,
        name: meta?.name ?? r.ruleId,
        kind: meta?.kind ?? "waste",
        count: r.count,
        kwh: round(r.kwh, 1),
      };
    }),
    disclosures: reportDisclosures(locationFactor, residualFactor, kwh ? measured / kwh : 0),
  };
}

export interface FloorNow {
  floorId: string;
  label: string;
  level: number;
  tenantId: string | null;
  at: number | null;
  occupancy: number;
  hvacMode: string;
  lightsOn: number;
  /** cooled or lit while nobody is counted */
  wasteNow: boolean;
  avoidableKwh28d: number;
  openFindings: number;
}

/** Latest state per floor plus the 28-day avoidable energy, for the overview screen. */
export async function floorsNow(tx: Tx, ctx: BuildingContext, today: string): Promise<FloorNow[]> {
  const latest = await tx.execute<{
    floor_id: string;
    start_at: Date;
    occupancy: number;
    hvac_mode: string;
    hvac_on: number;
    lights_on: number;
  }>(sql`
    select distinct on (floor_id) floor_id, start_at, occupancy, hvac_mode, hvac_on, lights_on
    from ${schema.floorIntervals}
    where building_id = ${ctx.building.id} and start_at > now() - interval '3 days'
    order by floor_id, start_at desc`);
  const avoid = await tx
    .select({
      floorId: schema.floorDaily.floorId,
      kwh: sql<number>`coalesce(sum(${schema.floorDaily.avoidableKwh}),0)::float8`,
    })
    .from(schema.floorDaily)
    .where(
      and(
        eq(schema.floorDaily.buildingId, ctx.building.id),
        gte(schema.floorDaily.day, addDays(today, -28)),
        lt(schema.floorDaily.day, addDays(today, 1)),
      ),
    )
    .groupBy(schema.floorDaily.floorId);
  const open = await tx
    .select({ floorId: schema.findings.floorId, n: sql<number>`count(*)::int` })
    .from(schema.findings)
    .where(and(eq(schema.findings.buildingId, ctx.building.id), eq(schema.findings.status, "open")))
    .groupBy(schema.findings.floorId);
  const latestBy = new Map([...latest].map((r) => [r.floor_id, r]));
  const avoidBy = new Map(avoid.map((r) => [r.floorId, r.kwh]));
  const openBy = new Map(open.map((r) => [r.floorId, r.n]));
  return ctx.floors
    .map((f) => {
      const l = latestBy.get(f.id);
      return {
        floorId: f.id,
        label: f.label,
        level: f.level,
        tenantId: f.tenantId,
        at: l ? new Date(l.start_at).getTime() : null,
        occupancy: l?.occupancy ?? 0,
        hvacMode: l?.hvac_mode ?? "off",
        lightsOn: l?.lights_on ?? 0,
        wasteNow: !!l && l.occupancy === 0 && (l.hvac_on > 0 || l.lights_on >= 0.2),
        avoidableKwh28d: round(avoidBy.get(f.id) ?? 0, 1),
        openFindings: openBy.get(f.id) ?? 0,
      };
    })
    .sort((a, b) => b.level - a.level);
}

export async function latestDataDay(tx: Tx, ctx: BuildingContext): Promise<string | null> {
  const [r] = await tx
    .select({ day: schema.floorDaily.day })
    .from(schema.floorDaily)
    .where(eq(schema.floorDaily.buildingId, ctx.building.id))
    .orderBy(desc(schema.floorDaily.day))
    .limit(1);
  return r?.day ?? null;
}
