import type { DayType } from "./calendar";
import type { FloorProfile } from "./model";
import { round } from "./model";
import type { Finding, RuleId } from "./rules";

export type StrategyId =
  | "occupancy_gated_workday"
  | "zone_only_non_working"
  | "auto_lights_off"
  | "full_package";

export interface StrategyMeta {
  id: StrategyId;
  name: string;
  description: string;
  /** which findings the strategy removes, by rule and day type */
  covers: { rule: RuleId; dayTypes: DayType[] }[];
  /** hardware needed per floor (keys of CapexModel.perFloor) */
  hardware: (keyof CapexModel["perFloor"])[];
}

export const STRATEGIES: Record<Exclude<StrategyId, "full_package">, StrategyMeta> = {
  occupancy_gated_workday: {
    id: "occupancy_gated_workday",
    name: "Occupancy-gated weekday cooling",
    description:
      "After hours on working days, a floor's zone runs only while people are counted on it, switches off after the grace period, and drops to a zone setback when fewer than the threshold remain.",
    covers: [
      { rule: "hvac_empty_floor", dayTypes: ["workday"] },
      { rule: "full_floor_few_people", dayTypes: ["workday"] },
    ],
    hardware: ["doorCounters", "zoneValves"],
  },
  zone_only_non_working: {
    id: "zone_only_non_working",
    name: "Zone-only cooling on weekends and holidays",
    description:
      "On non-working days only floors with an approved request are cooled, at full floor or setback depending on expected people; all other floors stay off.",
    covers: [
      { rule: "hvac_unrequested_non_working", dayTypes: ["weekend", "holiday"] },
      { rule: "hvac_empty_floor", dayTypes: ["weekend", "holiday"] },
      { rule: "full_floor_few_people", dayTypes: ["weekend", "holiday"] },
    ],
    hardware: ["doorCounters", "zoneValves"],
  },
  auto_lights_off: {
    id: "auto_lights_off",
    name: "Automatic lights-off on empty floors at night",
    description:
      "Lighting above the security level switches off when the floor has been empty at night for the grace period.",
    covers: [{ rule: "lights_on_empty_night", dayTypes: ["workday", "weekend", "holiday"] }],
    hardware: ["doorCounters", "lightingRelays"],
  },
};

/**
 * What a measure on a floor can do about a finding: one of the control strategies, or an on-site check when the
 * cause has to be found first.
 */
export type MeasureStrategyId = Exclude<StrategyId, "full_package"> | "investigate_on_site";
export const MEASURE_STRATEGY_IDS = [
  "occupancy_gated_workday",
  "zone_only_non_working",
  "auto_lights_off",
  "investigate_on_site",
] as const satisfies readonly MeasureStrategyId[];

const EVERY_DAY: DayType[] = ["workday", "weekend", "holiday"];

/**
 * The findings a measure answers on its floor: the rules and day types its strategy removes. An on-site check
 * answers the kind of finding it was opened for, on any day.
 */
export function measureCovers(
  strategyId: MeasureStrategyId,
  originRule: RuleId,
): { rule: RuleId; dayTypes: DayType[] }[] {
  if (strategyId === "investigate_on_site") return [{ rule: originRule, dayTypes: EVERY_DAY }];
  return STRATEGIES[strategyId].covers;
}

export function covers(
  list: readonly { rule: RuleId; dayTypes: readonly DayType[] }[],
  f: { ruleId: string; dayType: DayType },
): boolean {
  return list.some((c) => c.rule === f.ruleId && c.dayTypes.includes(f.dayType));
}

/** The strategies that remove a finding of this rule on this kind of day, then an on-site check. */
export function strategiesFor(rule: RuleId, dayType: DayType): MeasureStrategyId[] {
  const fitting = (Object.keys(STRATEGIES) as Exclude<StrategyId, "full_package">[]).filter((id) =>
    covers(STRATEGIES[id].covers, { ruleId: rule, dayType }),
  );
  return [...fitting, "investigate_on_site"];
}

export interface CapexModel {
  perFloor: { doorCounters: number; zoneValves: number; lightingRelays: number };
  integrationFixed: number;
}

/**
 * Order-of-magnitude capex, to replace with supplier quotes: two door counters at ¥3,000, zone valve
 * actuators ¥15,000 and lighting relays ¥1,000 per floor, plus fixed BMS integration labour.
 */
export const DEFAULT_CAPEX: CapexModel = {
  perFloor: { doorCounters: 6_000, zoneValves: 15_000, lightingRelays: 1_000 },
  integrationFixed: 16_000,
};

export interface AnnualisationBasis {
  /** days of each type in the history window */
  observed: Record<DayType, number>;
  /** days of each type in a year */
  annual: Record<DayType, number>;
}

export const DEFAULT_ANNUAL_DAYS: Record<DayType, number> = { workday: 250, weekend: 104, holiday: 11 };

export interface StrategyEstimate {
  id: StrategyId;
  name: string;
  observedKwh: number;
  annualKwh: number;
  capex: number;
  floors: number;
}

function annualise(kwhByType: Record<DayType, number>, basis: AnnualisationBasis): number {
  let total = 0;
  for (const t of ["workday", "weekend", "holiday"] as const) {
    if (basis.observed[t] > 0) total += (kwhByType[t] / basis.observed[t]) * basis.annual[t];
  }
  return total;
}

function capexFor(hardware: StrategyMeta["hardware"], floors: number, model: CapexModel): number {
  const perFloor = [...new Set(hardware)].reduce((s, h) => s + model.perFloor[h], 0);
  return perFloor * floors + model.integrationFixed;
}

/**
 * Annual saving of each strategy, extrapolated from the findings in an observed window
 * (per day type, so a window full of holidays is not mistaken for a normal month).
 */
export function estimateStrategies(
  findings: readonly Finding[],
  floors: readonly FloorProfile[],
  basis: AnnualisationBasis,
  capex: CapexModel = DEFAULT_CAPEX,
): StrategyEstimate[] {
  const n = floors.length;
  const out: StrategyEstimate[] = [];
  const allHardware = new Set<keyof CapexModel["perFloor"]>();
  const fullByType: Record<DayType, number> = { workday: 0, weekend: 0, holiday: 0 };
  let fullObserved = 0;
  for (const meta of Object.values(STRATEGIES)) {
    const byType: Record<DayType, number> = { workday: 0, weekend: 0, holiday: 0 };
    let observed = 0;
    for (const f of findings) {
      if (meta.covers.some((c) => c.rule === f.ruleId && c.dayTypes.includes(f.dayType))) {
        byType[f.dayType] += f.avoidableKwh;
        observed += f.avoidableKwh;
      }
    }
    for (const t of Object.keys(byType) as DayType[]) fullByType[t] += byType[t];
    fullObserved += observed;
    for (const h of meta.hardware) allHardware.add(h);
    out.push({
      id: meta.id,
      name: meta.name,
      observedKwh: round(observed, 1),
      annualKwh: round(annualise(byType, basis), 0),
      capex: capexFor(meta.hardware, n, capex),
      floors: n,
    });
  }
  out.push({
    id: "full_package",
    name: "Full package (all three)",
    observedKwh: round(fullObserved, 1),
    annualKwh: round(annualise(fullByType, basis), 0),
    capex: capexFor([...allHardware], n, capex),
    floors: n,
  });
  return out;
}
