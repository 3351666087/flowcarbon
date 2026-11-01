import type { DayType } from "./calendar";
import type { FloorProfile } from "./model";
import { round } from "./model";
import type { RuleId } from "./rules";
import {
  type AnnualisationBasis,
  type CapexModel,
  covers,
  DEFAULT_CAPEX,
  estimateStrategies,
  floorCapex,
  type MeasureStrategyId,
  measureCovers,
  STRATEGIES,
  type StrategyId,
  type StrategyMeta,
} from "./strategies";

/**
 * The share of the covered avoidable energy a strategy actually saves. A stated assumption, not a measurement, shown
 * wherever its result is: `mid` gives the expected figure, `low` and `high` the ends of the range around it.
 */
export const REALISATION = { low: 0.6, mid: 0.8, high: 0.95 } as const;

/** With no target, a candidate must carry this share of its option's total to be worth an action. */
const MIN_ACTION_SHARE = 0.05;
const MAX_ACTIONS = 8;
/** floating-point noise when comparing with a target, far below anything a person would read */
const EPSILON = 1e-9;

/** The strategies a plan can switch on. An on-site check is opened from a finding, never planned. */
export type PlanStrategyId = Exclude<StrategyId, "full_package">;
export type PlanOptionId = "weekends" | "weekdays" | "balanced" | "community";
/** `value` is a fraction: 0.05 for 5 %. */
export type PlanTarget = { kind: "avoidable_share" | "avoidable_cut" | "energy_cut"; value: number } | null;
export type PlanFocus = "all" | "hvac" | "lights";
/** A recipe another building can reuse: which strategies, on what share of a building's floors. Holds no floor ids. */
export type MeasureStrategyMix = readonly { strategyId: PlanStrategyId; floorShare: number }[];

export interface PlanRequest {
  target: PlanTarget;
  focus: PlanFocus;
  /** only these floors may be acted on */
  floorIds?: readonly string[];
  /** only this mix: the plan is then a single `community` option */
  only?: MeasureStrategyMix;
}

/** An open finding in the window, as far as a plan needs to know it. */
export interface PlanFinding {
  floorId: string;
  ruleId: RuleId;
  dayType: DayType;
  avoidableKwh: number;
}

/** What the building did over the window. Cost and CO2e divided by energy are its blended rates. */
export interface PlanTotals {
  kwh: number;
  cost: number;
  co2eKg: number;
  avoidableKwh: number;
  greenShare: number;
}

export interface PlanInput {
  window: { from: string; to: string };
  totals: PlanTotals;
  /** the window's findings that are still open, see `splitFindings` */
  findings: readonly PlanFinding[];
  floors: readonly FloorProfile[];
  basis: AnnualisationBasis;
  /** in the building's currency; null with no estimate in it, because a figure must not change currency unconverted */
  capex: CapexModel | null;
  /** the window's avoidable energy that measures already adopted answer, before realisation */
  adoptedKwh?: number;
  /** the active measures this rests on */
  measureIds?: readonly string[];
}

export interface PlanMetrics {
  kwh: number;
  cost: number;
  co2eKg: number;
  avoidableKwh: number;
  avoidableShare: number;
  greenShare: number;
}

export interface PlanAction {
  floorId: string;
  strategyId: PlanStrategyId;
  /** avoidable energy in the window this action answers, before realisation */
  coveredKwh: number;
  /** how many findings that is */
  findings: number;
  /** `coveredKwh` by kind of day, so a client can recombine actions without asking again */
  byDayType: Record<DayType, number>;
}

export interface PlanOption {
  id: PlanOptionId;
  actions: PlanAction[];
  /** expected, at `REALISATION.mid` */
  after: PlanMetrics;
  /** the cautious end of the range, at `REALISATION.low`: it saves the least, so its energy is the highest */
  low: PlanMetrics;
  /** the optimistic end, at `REALISATION.high` */
  high: PlanMetrics;
  annualSavingKwh: number;
  annualSavingCost: number;
  /** in the building's currency; null with no estimate in it */
  capex: number | null;
  /** whether `after` meets the request's target; false when there is no target */
  reachesTarget: boolean;
  /** whether `low` meets it too, so the whole range does */
  reachesAtLow: boolean;
  /** how far `after` stays from the target, as a fraction like the target's value; null when it is met or absent */
  shortBy: number | null;
}

export interface Plan {
  window: { from: string; to: string; days: number; observed: Record<DayType, number> };
  /** the window as the data recorded it */
  recorded: PlanMetrics;
  /** where the building stands: `recorded`, less what adopted measures are expected to save. Options start here. */
  before: PlanMetrics;
  /** the avoidable energy those measures answer, before realisation */
  adoptedKwh: number;
  /** the active measures it rests on, so that an old plan can tell when they have changed */
  measureIds: string[];
  options: PlanOption[];
  realisation: { low: number; mid: number; high: number };
  /** the building meets the target as it stands, adopted measures included */
  alreadyMet: boolean;
}

interface Candidate {
  floorId: string;
  strategyId: PlanStrategyId;
  rows: readonly PlanFinding[];
  kwh: number;
}

const DAY_TYPES: readonly DayType[] = ["workday", "weekend", "holiday"];
const WEEKEND_STRATEGIES: readonly PlanStrategyId[] = ["zone_only_non_working"];
const WEEKDAY_STRATEGIES: readonly PlanStrategyId[] = ["occupancy_gated_workday", "auto_lights_off"];
const FOCUS: Record<PlanFocus, readonly PlanStrategyId[]> = {
  all: [...WEEKEND_STRATEGIES, ...WEEKDAY_STRATEGIES],
  hvac: ["zone_only_non_working", "occupancy_gated_workday"],
  lights: ["auto_lights_off"],
};

const sumKwh = (rows: readonly PlanFinding[]) => rows.reduce((s, f) => s + f.avoidableKwh, 0);

function kwhByDayType(rows: readonly PlanFinding[]): Record<DayType, number> {
  const out: Record<DayType, number> = { workday: 0, weekend: 0, holiday: 0 };
  for (const f of rows) out[f.dayType] += f.avoidableKwh;
  for (const t of DAY_TYPES) out[t] = round(out[t], 1);
  return out;
}

const largestFirst = (a: Candidate, b: Candidate) =>
  b.kwh - a.kwh || a.floorId.localeCompare(b.floorId) || a.strategyId.localeCompare(b.strategyId);

/** The building's figures once `savedKwh` is gone: same blended rates, same green energy over a lower total. */
export function planMetrics(totals: PlanTotals, savedKwh = 0): PlanMetrics {
  const kwh = Math.max(0, totals.kwh - savedKwh);
  const avoidable = Math.max(0, totals.avoidableKwh - savedKwh);
  const blended = (amount: number) => (totals.kwh > 0 ? (kwh * amount) / totals.kwh : 0);
  return {
    kwh: round(kwh, 1),
    cost: round(blended(totals.cost), 2),
    co2eKg: round(blended(totals.co2eKg), 1),
    avoidableKwh: round(avoidable, 1),
    avoidableShare: kwh > 0 ? avoidable / kwh : 0,
    greenShare: kwh > 0 ? Math.min(1, (totals.greenShare * totals.kwh) / kwh) : 0,
  };
}

/** How far the building is from a target once `savedKwh` is gone, as a fraction; zero or less means it is met. */
function shortfall(target: NonNullable<PlanTarget>, totals: PlanTotals, savedKwh: number): number {
  const kwh = Math.max(0, totals.kwh - savedKwh);
  const avoidable = Math.max(0, totals.avoidableKwh - savedKwh);
  switch (target.kind) {
    case "avoidable_share":
      return (kwh > 0 ? avoidable / kwh : 0) - target.value;
    case "avoidable_cut":
      return totals.avoidableKwh > 0 ? target.value - (1 - avoidable / totals.avoidableKwh) : 0;
    case "energy_cut":
      return totals.kwh > 0 ? target.value - (1 - kwh / totals.kwh) : 0;
  }
}

/** Every floor the strategy could act on, with the findings it would remove there. */
function candidatesFor(strategyId: PlanStrategyId, findings: readonly PlanFinding[]): Candidate[] {
  const byFloor = new Map<string, PlanFinding[]>();
  for (const f of findings) {
    if (!covers(STRATEGIES[strategyId].covers, f)) continue;
    const rows = byFloor.get(f.floorId);
    if (rows) rows.push(f);
    else byFloor.set(f.floorId, [f]);
  }
  return [...byFloor]
    .map(([floorId, rows]) => ({ floorId, strategyId, rows, kwh: sumKwh(rows) }))
    .filter((c) => c.kwh > 0);
}

/** Takes from each side in turn, starting with the one that holds the largest candidate. */
function alternate(a: readonly Candidate[], b: readonly Candidate[] = []): Candidate[] {
  const [first, second] = (a[0]?.kwh ?? 0) >= (b[0]?.kwh ?? 0) ? [a, b] : [b, a];
  const out: Candidate[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [first[i], second[i]];
    if (x) out.push(x);
    if (y) out.push(y);
  }
  return out;
}

/** The candidates of each option: one side, or two to alternate between. */
function pools(
  findings: readonly PlanFinding[],
  floors: number,
  request: PlanRequest,
): { id: PlanOptionId; sides: [Candidate[], Candidate[]?] }[] {
  const allowed = FOCUS[request.focus];
  if (request.only) {
    const pool = request.only.flatMap(({ strategyId, floorShare }) =>
      allowed.includes(strategyId)
        ? candidatesFor(strategyId, findings)
            .sort(largestFirst)
            .slice(0, Math.ceil(round(floorShare * floors, 6)))
        : [],
    );
    return [{ id: "community", sides: [pool.sort(largestFirst)] }];
  }
  const side = (strategies: readonly PlanStrategyId[]) =>
    strategies
      .filter((id) => allowed.includes(id))
      .flatMap((id) => candidatesFor(id, findings))
      .sort(largestFirst);
  const weekends = side(WEEKEND_STRATEGIES);
  const weekdays = side(WEEKDAY_STRATEGIES);
  return [
    { id: "weekends", sides: [weekends] },
    { id: "weekdays", sides: [weekdays] },
    { id: "balanced", sides: [weekends, weekdays] },
  ];
}

/** At least `MIN_ACTION_SHARE` of the total, or the largest few where a tall building spreads it thinner than that. */
function worthHaving(side: readonly Candidate[]): readonly Candidate[] {
  const total = side.reduce((s, c) => s + c.kwh, 0);
  const worth = side.filter((c) => c.kwh >= MIN_ACTION_SHARE * total);
  return worth.length ? worth : side;
}

/**
 * The candidates an option takes. With a goal it walks them all until the goal is met. Without one it takes those worth
 * having, each judged within its side, or the smaller side of a balanced option would never get a turn; floors the
 * person named are all taken, however little they hold. A finding taken once is gone for every later candidate.
 */
function choose(
  sides: [Candidate[], Candidate[]?],
  goal: PlanTarget,
  totals: PlanTotals,
  { named, adoptedSaved }: { named: boolean; adoptedSaved: number },
): Candidate[] {
  const [a, b] = sides;
  const order =
    goal || named ? alternate(a, b) : alternate(worthHaving(a), b && worthHaving(b)).slice(0, MAX_ACTIONS);
  const taken = new Set<PlanFinding>();
  const picks: Candidate[] = [];
  let covered = 0;
  for (const c of order) {
    if (goal && shortfall(goal, totals, adoptedSaved + covered * REALISATION.mid) <= EPSILON) break;
    const rows = c.rows.filter((f) => !taken.has(f));
    if (!rows.length) continue;
    for (const f of rows) taken.add(f);
    const kwh = sumKwh(rows);
    covered += kwh;
    picks.push({ ...c, rows, kwh });
  }
  return picks;
}

function toOption(
  id: PlanOptionId,
  picks: readonly Candidate[],
  input: PlanInput,
  target: PlanTarget,
  adoptedSaved: number,
): PlanOption {
  const { totals, basis, capex: model } = input;
  const covered = picks.reduce((s, c) => s + c.kwh, 0);
  const saved = (share: number) => adoptedSaved + covered * share;
  const annual = estimateStrategies(
    picks.flatMap((c) => c.rows),
    input.floors,
    basis,
    model ?? DEFAULT_CAPEX,
  ).find((e) => e.id === "full_package")!;
  const hardware = new Map<string, StrategyMeta["hardware"]>();
  for (const c of picks)
    hardware.set(c.floorId, [...(hardware.get(c.floorId) ?? []), ...STRATEGIES[c.strategyId].hardware]);
  const capex =
    model && [...hardware.values()].reduce((s, h) => s + floorCapex(h, model), model.integrationFixed);
  const annualSavingKwh = round(annual.annualKwh * REALISATION.mid, 0);
  const short = target ? shortfall(target, totals, saved(REALISATION.mid)) : null;
  const reachesTarget = short !== null && short <= EPSILON;
  const reachesAtLow = !!target && shortfall(target, totals, saved(REALISATION.low)) <= EPSILON;
  return {
    id,
    actions: picks.map((c) => ({
      floorId: c.floorId,
      strategyId: c.strategyId,
      coveredKwh: round(c.kwh, 1),
      findings: c.rows.length,
      byDayType: kwhByDayType(c.rows),
    })),
    after: planMetrics(totals, saved(REALISATION.mid)),
    low: planMetrics(totals, saved(REALISATION.low)),
    high: planMetrics(totals, saved(REALISATION.high)),
    annualSavingKwh,
    annualSavingCost: totals.kwh > 0 ? round((annualSavingKwh * totals.cost) / totals.kwh, 0) : 0,
    capex,
    reachesTarget,
    reachesAtLow,
    shortBy: short === null || reachesTarget ? null : short,
  };
}

/**
 * The strategies open to a building for a request. All numbers are computed here from the building's own data; the
 * model that may present them adds none.
 *
 * A candidate is a (floor, strategy) pair and removes the findings it covers, a finding counting once. An option
 * takes candidates largest first until the target is met at `REALISATION.mid`; with no target (or one already met) it
 * takes those worth having. An option with no candidates, or the same actions as an earlier one, is left out.
 *
 * Measures already adopted count at `REALISATION.mid`: `before`, every option's figures and every target check stand
 * on them, so an option is what it adds to the building as it now stands. A target of a cut is still a cut from what
 * the window recorded, which is why asking for the same one again finds it met.
 */
export function buildPlan(input: PlanInput, request: PlanRequest = { target: null, focus: "all" }): Plan {
  const { totals, basis, adoptedKwh = 0, measureIds = [] } = input;
  const { target, floorIds } = request;
  const adoptedSaved = adoptedKwh * REALISATION.mid;
  const alreadyMet = !!target && totals.kwh > 0 && shortfall(target, totals, adoptedSaved) <= EPSILON;
  const findings = floorIds ? input.findings.filter((f) => floorIds.includes(f.floorId)) : input.findings;
  const options: PlanOption[] = [];
  const seen = new Set<string>();
  for (const { id, sides } of pools(findings, input.floors.length, request)) {
    const picks = choose(sides, alreadyMet ? null : target, totals, { named: !!floorIds, adoptedSaved });
    const key = picks
      .map((c) => `${c.floorId}|${c.strategyId}`)
      .sort()
      .join();
    if (!picks.length || seen.has(key)) continue;
    seen.add(key);
    options.push(toOption(id, picks, input, target, adoptedSaved));
  }
  return {
    window: {
      ...input.window,
      days: DAY_TYPES.reduce((s, t) => s + basis.observed[t], 0),
      observed: basis.observed,
    },
    recorded: planMetrics(totals),
    before: planMetrics(totals, adoptedSaved),
    adoptedKwh: round(adoptedKwh, 1),
    measureIds: [...measureIds],
    options,
    realisation: REALISATION,
    alreadyMet,
  };
}

/** What a measure is expected to save in a week, with the range around it. */
export interface WeeklySaving {
  kwh: number;
  cost: number;
  /** at `REALISATION.low` and `REALISATION.high` */
  lowKwh: number;
  highKwh: number;
}

/**
 * What covered avoidable energy comes to in a week: the figure a plan's card gives for its window, at `REALISATION`,
 * over seven days of that window instead of all of them. Cost is at the blended rate, as in `planMetrics`.
 */
export function weeklySaving(
  coveredKwh: number,
  days: number,
  totals: Pick<PlanTotals, "kwh" | "cost">,
): WeeklySaving {
  const week = days > 0 ? (coveredKwh * 7) / days : 0;
  const rate = totals.kwh > 0 ? totals.cost / totals.kwh : 0;
  return {
    kwh: round(week * REALISATION.mid, 1),
    cost: round(week * REALISATION.mid * rate, 2),
    lowKwh: round(week * REALISATION.low, 1),
    highKwh: round(week * REALISATION.high, 1),
  };
}

/** A finding in the window, with what people have done about it. */
export interface WindowFinding extends PlanFinding {
  status: "open" | "acknowledged" | "fixed" | "dismissed";
  measureId: string | null;
}

/** A measure that is planned or in effect. */
export interface ActiveMeasure {
  id: string;
  floorId: string;
  strategyId: MeasureStrategyId;
  originRuleId: RuleId;
  status: "planned" | "in_effect";
}

export interface MeasureCoverage extends ActiveMeasure {
  coveredKwh: number;
  findings: number;
  byDayType: Record<DayType, number>;
}

/** An on-site check answers findings until its cause is known, but it switches nothing, so it saves nothing yet. */
export const savesEnergy = (m: Pick<ActiveMeasure, "strategyId">) => m.strategyId !== "investigate_on_site";

/**
 * Sorts a window's findings into what the active measures already answer and what is still open. A finding belongs
 * to the measure it is linked to, otherwise to the first one that covers it, so two measures on a floor never count
 * it twice. One that came back under a measure stays with that measure: planning its floor again would change nothing.
 */
export function splitFindings(
  findings: readonly WindowFinding[],
  measures: readonly ActiveMeasure[],
): { open: PlanFinding[]; adopted: MeasureCoverage[] } {
  const answered = new Map<string, PlanFinding[]>(measures.map((m) => [m.id, []]));
  const open: PlanFinding[] = [];
  for (const f of findings) {
    if (f.status === "dismissed") continue;
    const measure =
      measures.find((m) => m.id === f.measureId) ??
      measures.find((m) => m.floorId === f.floorId && covers(measureCovers(m.strategyId, m.originRuleId), f));
    if (measure) answered.get(measure.id)!.push(f);
    else if (f.status === "open") open.push(f);
  }
  return {
    open,
    adopted: measures.map((m) => {
      const rows = answered.get(m.id)!;
      return {
        ...m,
        coveredKwh: round(sumKwh(rows), 1),
        findings: rows.length,
        byDayType: kwhByDayType(rows),
      };
    }),
  };
}

/** The window per kind of day: how many days there were and the energy they used. */
export interface DayHistory {
  observed: Record<DayType, number>;
  kwh: Record<DayType, number>;
}

export interface UpcomingDay {
  date: string;
  dayType: DayType;
}

export interface WeekDay extends UpcomingDay {
  /** days of this kind the figures rest on; 0 = no history, so no figure, as in a floor forecast */
  basis: number;
  /** expected energy with nothing changed */
  withoutKwh: number;
  /** expected energy with the strategies, at `REALISATION.mid` */
  withKwh: number;
  /** the same at `REALISATION.low` (saves the least) */
  lowKwh: number;
  /** the same at `REALISATION.high` */
  highKwh: number;
}

/**
 * Expected energy of the upcoming days from the per-day-type averages in the window, without and with a set of
 * strategies. `covered` is the avoidable energy the set answers in the window, by kind of day.
 */
export function weekAhead(
  history: DayHistory,
  days: readonly UpcomingDay[],
  covered: Record<DayType, number>,
): WeekDay[] {
  return days.map(({ date, dayType }) => {
    const basis = history.observed[dayType];
    const without = basis > 0 ? history.kwh[dayType] / basis : 0;
    const perDay = basis > 0 ? covered[dayType] / basis : 0;
    const expected = (share: number) => round(Math.max(0, without - perDay * share), 1);
    return {
      date,
      dayType,
      basis,
      withoutKwh: round(without, 1),
      withKwh: expected(REALISATION.mid),
      lowKwh: expected(REALISATION.low),
      highKwh: expected(REALISATION.high),
    };
  });
}

/** What one strategy of an option takes off a day of each kind, at `REALISATION.mid`. */
export interface WeekCoverage {
  option: PlanOptionId;
  strategyId: PlanStrategyId;
  perDayKwh: Record<DayType, number>;
}

/** Lets a client take a selected option off a `weekAhead` line without a round trip: subtract by the day's kind. */
export function weekCoverage(plan: Plan): WeekCoverage[] {
  const { observed } = plan.window;
  return plan.options.flatMap((option) => {
    const byStrategy = new Map<PlanStrategyId, Record<DayType, number>>();
    for (const a of option.actions) {
      const perDay = byStrategy.get(a.strategyId) ?? { workday: 0, weekend: 0, holiday: 0 };
      for (const t of DAY_TYPES)
        if (observed[t] > 0) perDay[t] += (a.byDayType[t] * plan.realisation.mid) / observed[t];
      byStrategy.set(a.strategyId, perDay);
    }
    return [...byStrategy].map(([strategyId, perDay]) => ({
      option: option.id,
      strategyId,
      perDayKwh: {
        workday: round(perDay.workday, 2),
        weekend: round(perDay.weekend, 2),
        holiday: round(perDay.holiday, 2),
      },
    }));
  });
}
