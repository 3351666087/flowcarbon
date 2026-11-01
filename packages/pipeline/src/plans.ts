import {
  type ActiveMeasure,
  buildPlan,
  CAPEX_CURRENCY,
  Calendar,
  covers,
  type DayHistory,
  type DayType,
  DEFAULT_ANNUAL_DAYS,
  DEFAULT_CAPEX,
  type MeasureCoverage,
  type MeasureStrategyId,
  measureCovers,
  type Plan,
  type PlanInput,
  type PlanMetrics,
  type PlanRequest,
  type RuleId,
  savesEnergy,
  splitFindings,
  type UpcomingDay,
  type WeekCoverage,
  type WeekDay,
  type WeeklySaving,
  weekAhead,
  weekCoverage,
  weeklySaving,
} from "@flowcarbon/core";
import { schema, type Tx } from "@flowcarbon/db";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { buildingReport, latestDataDay } from "./analytics";
import { type BuildingContext, localDateOf } from "./context";
import { addDays, dayWindow } from "./recompute";

/** days a plan looks back from the building's last day of data, the same window as its "last 28 days" figures */
const WINDOW_DAYS = 28;
const WEEK_DAYS = 7;

interface PlanSource {
  input: PlanInput;
  adopted: MeasureCoverage[];
  history: DayHistory;
  lastDataDay: string | null;
}

const DAY_TYPES = ["workday", "weekend", "holiday"] as const satisfies readonly DayType[];
const noDays = (): Record<DayType, number> => ({ workday: 0, weekend: 0, holiday: 0 });

/**
 * Everything a plan rests on. The window ends at the last whole day of data, so a building whose data ended still has
 * one, and a live building's today, which is still coming in, does not pass for a full day. Only days with data count:
 * a shorter history gives a smaller basis, never invented days.
 */
async function planSource(tx: Tx, ctx: BuildingContext, now: number): Promise<PlanSource> {
  const floors = ctx.floors;
  const capex = ctx.building.currency === CAPEX_CURRENCY ? DEFAULT_CAPEX : null;
  const today = localDateOf(ctx, now);
  const latest = await latestDataDay(tx, ctx);
  const lastDataDay = latest && latest >= today ? addDays(today, -1) : latest;
  if (!lastDataDay) {
    return {
      input: {
        window: { from: today, to: today },
        totals: { kwh: 0, cost: 0, co2eKg: 0, avoidableKwh: 0, greenShare: 0 },
        findings: [],
        floors,
        basis: { observed: noDays(), annual: DEFAULT_ANNUAL_DAYS },
        capex,
      },
      adopted: [],
      history: { observed: noDays(), kwh: noDays() },
      lastDataDay,
    };
  }
  const window = { from: addDays(lastDataDay, 1 - WINDOW_DAYS), to: addDays(lastDataDay, 1) };
  const report = await buildingReport(tx, ctx, window.from, window.to);
  const { from, to } = dayWindow(ctx.building, window.from, window.to);
  const [rows, measures] = await Promise.all([
    tx
      .select({
        floorId: schema.findings.floorId,
        ruleId: schema.findings.ruleId,
        dayType: schema.findings.dayType,
        avoidableKwh: schema.findings.avoidableKwh,
        status: schema.findings.status,
        measureId: schema.findings.measureId,
      })
      .from(schema.findings)
      .where(
        and(
          eq(schema.findings.buildingId, ctx.building.id),
          gte(schema.findings.startAt, new Date(from)),
          lt(schema.findings.startAt, new Date(to)),
        ),
      )
      // fixed order, so floating-point sums (and therefore plans) are reproducible
      .orderBy(schema.findings.startAt, schema.findings.floorId, schema.findings.ruleId),
    tx
      .select({
        id: schema.measures.id,
        floorId: schema.measures.floorId,
        strategyId: schema.measures.strategyId,
        originRuleId: schema.measures.originRuleId,
        status: schema.measures.status,
      })
      .from(schema.measures)
      .where(
        and(
          eq(schema.measures.buildingId, ctx.building.id),
          inArray(schema.measures.status, ["planned", "in_effect"]),
        ),
      )
      .orderBy(schema.measures.createdAt),
  ]);
  const { open, adopted } = splitFindings(
    rows.map((f) => ({ ...f, ruleId: f.ruleId as RuleId })),
    measures.map((m) => ({
      ...m,
      strategyId: m.strategyId as MeasureStrategyId,
      originRuleId: m.originRuleId as RuleId,
      status: m.status as ActiveMeasure["status"],
    })),
  );
  const kwh = noDays();
  for (const t of report.byDayType) kwh[t.dayType] = t.kwh;
  const observed = report.period.dayTypes;
  return {
    input: {
      window,
      totals: {
        kwh: report.totals.kwh,
        cost: report.totals.cost,
        co2eKg: report.scope2.locationBasedKg,
        avoidableKwh: report.totals.avoidableKwh,
        greenShare: report.scope2.greenShare,
      },
      findings: open,
      floors,
      basis: { observed, annual: DEFAULT_ANNUAL_DAYS },
      capex,
      adoptedKwh: adopted.filter(savesEnergy).reduce((s, m) => s + m.coveredKwh, 0),
      measureIds: adopted.map((m) => m.id),
    },
    adopted,
    history: { observed, kwh },
    lastDataDay,
  };
}

/** The strategies open to the building for a request (by default: no target, every floor, every kind of strategy). */
export async function planData(
  tx: Tx,
  ctx: BuildingContext,
  opts: Partial<PlanRequest> = {},
  now = Date.now(),
): Promise<Plan> {
  const { input } = await planSource(tx, ctx, now);
  return buildPlan(input, { ...opts, target: opts.target ?? null, focus: opts.focus ?? "all" });
}

/** A measure as far as its expected saving goes. */
type Expectable = Pick<ActiveMeasure, "id" | "floorId" | "strategyId" | "originRuleId">;

export interface MeasureFooting {
  /** days of data behind the figures: the plan's window */
  days: number;
  /** what the measure is expected to save in a week; nothing for an on-site check, which switches nothing */
  expected: (m: Expectable) => WeeklySaving;
}

/**
 * Measures' expected savings on the footing of the plan they came from: its window, a finding counted once, and an
 * on-site check counted as nothing. A measure's figure is therefore its option's, a week at a time.
 */
export async function measureFooting(
  tx: Tx,
  ctx: BuildingContext,
  now = Date.now(),
): Promise<MeasureFooting> {
  const { input, adopted, history } = await planSource(tx, ctx, now);
  const days = DAY_TYPES.reduce((s, t) => s + history.observed[t], 0);
  return {
    days,
    expected: (m) => {
      const active = adopted.find((a) => a.id === m.id);
      // a cancelled measure's findings are open again: what it would have answered is what it still covers
      const coverage = measureCovers(m.strategyId, m.originRuleId);
      const covered =
        active?.coveredKwh ??
        input.findings
          .filter((f) => f.floorId === m.floorId && covers(coverage, f))
          .reduce((s, f) => s + f.avoidableKwh, 0);
      return weeklySaving(savesEnergy(m) ? covered : 0, days, input.totals);
    },
  };
}

export interface StrategyBoard {
  /** the options still open, with no target, each on top of what is adopted */
  plan: Plan;
  /** the measures planned or in effect, and the building's figures with them in place */
  adopted: { measures: MeasureCoverage[]; after: PlanMetrics };
  /**
   * The coming days without and with the measures that save energy. A selected option is the client's to add: subtract
   * its `coverage` rows from `withKwh`, by the day's kind.
   */
  week: { days: WeekDay[]; coverage: WeekCoverage[] };
}

/** The deterministic picture behind the strategies page. No AI involved. */
export async function strategyBoard(tx: Tx, ctx: BuildingContext, now = Date.now()): Promise<StrategyBoard> {
  const { input, adopted, history, lastDataDay } = await planSource(tx, ctx, now);
  const plan = buildPlan(input);
  const covered = noDays();
  for (const m of adopted.filter(savesEnergy))
    for (const t of Object.keys(covered) as DayType[]) covered[t] += m.byDayType[t];

  // a building whose data ended looks ahead from where it stopped, as its people forecast does
  const today = localDateOf(ctx, now);
  const next = lastDataDay ? addDays(lastDataDay, 1) : today;
  const start = next < today ? next : today;
  const calendar = new Calendar(ctx.building.calendar);
  const days: UpcomingDay[] = Array.from({ length: WEEK_DAYS }, (_, i) => {
    const date = addDays(start, i);
    return { date, dayType: calendar.dayType(date) };
  });

  return {
    plan,
    adopted: { measures: adopted, after: plan.before },
    week: { days: weekAhead(history, days, covered), coverage: weekCoverage(plan) },
  };
}
