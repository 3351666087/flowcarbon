import { Calendar, type DayType } from "./calendar";
import { type ContractualInstrument, type EmissionFactor, type Scope2Result, scope2 } from "./carbon";
import type { BuildingProfile, FloorInterval, FloorProfile } from "./model";
import { round, totalKwh } from "./model";
import {
  findingParty,
  type LeaseSpan,
  leasedOn,
  PARTIES,
  type Party,
  RESPONSIBILITY_DISCLOSURE,
  splitByParty,
} from "./responsibility";
import { type Finding, type FindingKind, RULES, type RuleId } from "./rules";
import { priceAt } from "./tariff";
import { localParts, parseClock } from "./time";

export interface PricedFinding extends Finding {
  avoidableCost: number;
  avoidableCo2eKg: number;
}

/** Adds cost (at the tariff in force at the middle of the finding) and location-based CO2e. */
export function priceFinding(f: Finding, building: BuildingProfile, factor: EmissionFactor): PricedFinding {
  const mid = f.start + (f.end - f.start) / 2;
  return {
    ...f,
    avoidableCost: round(f.avoidableKwh * priceAt(building.tariff, mid, building.timezone), 2),
    avoidableCo2eKg: round(f.avoidableKwh * factor.kgPerKwh, 1),
  };
}

export interface EnergyReport {
  period: { from: number; to: number; days: number; dayTypes: Record<DayType, number> };
  totals: {
    kwh: number;
    afterHoursKwh: number;
    cost: number;
    avoidableKwh: number;
    avoidableCost: number;
    avoidableShare: number;
    /** share of energy that was metered rather than estimated */
    measuredShare: number;
  };
  scope2: Scope2Result;
  avoidableCo2eKg: number;
  byFloor: {
    floorId: string;
    label: string;
    kwh: number;
    afterHoursKwh: number;
    avoidableKwh: number;
    /** lighting and plug loads while the floor was leased (see RESPONSIBILITY_DISCLOSURE) */
    tenantKwh: number;
    /** cooling, and everything on days the floor was vacant */
    buildingKwh: number;
    /** energy on days whose per-system split is not known: neither the tenant's nor the building's */
    unsplitKwh: number;
  }[];
  /**
   * who controls the energy, by system not by metered area; always both parties, tenant first. Shares are of
   * all the energy, so tenant + building + partyUnsplit add up to 1 (and their kWh to totals.kwh).
   */
  byParty: { party: Party; kwh: number; share: number; avoidableKwh: number }[];
  /**
   * Energy that could not be assigned to either party because the day's split by system is not known (a
   * floor-day stored before per-system roll-ups whose intervals are no longer available). Reported, not
   * hidden or spread proportionally; 0 when every day is split.
   */
  partyUnsplit: { kwh: number; share: number; floorDays: number };
  byDayType: { dayType: DayType; days: number; kwh: number; avoidableKwh: number }[];
  byRule: { ruleId: RuleId; name: string; kind: FindingKind; count: number; kwh: number }[];
  disclosures: string[];
}

/** First disclosure of a report on a simulated (demo) building. */
export const SIMULATED_DISCLOSURE =
  "All figures come from a simulated building and must not be used in a real report.";

/** Standard disclosures printed with every report; `simulated` puts the simulated-building warning first. */
export function reportDisclosures(
  locationFactor: EmissionFactor,
  residualFactor: EmissionFactor | undefined,
  measuredShare: number,
  opts: { simulated?: boolean; unsplit?: EnergyReport["partyUnsplit"] } = {},
): string[] {
  const u = opts.unsplit;
  return [
    ...(opts.simulated ? [SIMULATED_DISCLOSURE] : []),
    "Boundary: the office floors of this building under the property manager's operational control. Retail areas, car parks and tenants' own equipment beyond plug loads are outside the boundary.",
    RESPONSIBILITY_DISCLOSURE,
    ...(u && u.kwh > 0
      ? [
          `${u.kwh} kWh (${round(u.share * 100, 1)} % of the energy, on ${u.floorDays} ${u.floorDays === 1 ? "floor-day" : "floor-days"}) could not be split by system because those days' 15-minute data is no longer stored in full; it is reported as unsplit and counted as neither the tenant's nor the building's.`,
        ]
      : []),
    `Scope 2 location-based: electricity × ${locationFactor.kgPerKwh} kgCO2e/kWh (${locationFactor.source}, ${locationFactor.year}, ${locationFactor.status === "verified" ? "verified" : "to be verified"}).`,
    residualFactor
      ? `Scope 2 market-based: contractual instruments first, remainder at the residual-mix factor ${residualFactor.kgPerKwh} kgCO2e/kWh (${residualFactor.source}).`
      : "Scope 2 market-based: contractual instruments first; no residual-mix factor is published for this grid, so the remainder uses the location-based factor.",
    "Scope 1 and Scope 3 are not covered. This is an energy and carbon report, not an ESG report: it supplies the electricity and Scope 2 figures for the environmental part of an ESG or sustainability report.",
    `Avoidable energy is counted only where a documented rule fired (see rule rationale); ${round((1 - measuredShare) * 100, 0)} % of the energy in this period is estimated from rated power and run time rather than metered.`,
  ];
}

/** Accumulator for the tenant/building split, shared by the in-memory report and the pipeline's. */
export function emptyPartyTotals(): Record<Party, { kwh: number; avoidableKwh: number }> {
  return { tenant: { kwh: 0, avoidableKwh: 0 }, building: { kwh: 0, avoidableKwh: 0 } };
}

/**
 * Rounded byParty rows. Shares are of all the energy, the unsplit part included, so with partyUnsplitRow they
 * add up to 1 when there is any energy.
 */
export function partyRows(
  acc: Record<Party, { kwh: number; avoidableKwh: number }>,
  unsplitKwh = 0,
): EnergyReport["byParty"] {
  const total = acc.tenant.kwh + acc.building.kwh + unsplitKwh;
  return PARTIES.map((party) => ({
    party,
    kwh: round(acc[party].kwh, 1),
    share: total > 0 ? acc[party].kwh / total : 0,
    avoidableKwh: round(acc[party].avoidableKwh, 1),
  }));
}

/** The energy assigned to neither party, as a share of all of it. */
export function partyUnsplitRow(
  acc: Record<Party, { kwh: number; avoidableKwh: number }>,
  unsplitKwh: number,
  floorDays: number,
): EnergyReport["partyUnsplit"] {
  const total = acc.tenant.kwh + acc.building.kwh + unsplitKwh;
  return { kwh: round(unsplitKwh, 1), share: total > 0 ? unsplitKwh / total : 0, floorDays };
}

export interface ReportInput {
  building: BuildingProfile;
  floors: readonly FloorProfile[];
  intervals: readonly FloorInterval[];
  findings: readonly Finding[];
  locationFactor: EmissionFactor;
  instruments?: readonly ContractualInstrument[];
  residualFactor?: EmissionFactor;
  from: number;
  to: number;
  /** the building is simulated (a demo): the disclosures say so first */
  simulated?: boolean;
  /**
   * Leases by local date, to tell tenant-controlled from building-controlled energy on each day. Without them,
   * a floor counts as leased throughout when its profile has a tenant.
   */
  leases?: readonly LeaseSpan[];
}

export function buildReport(input: ReportInput): EnergyReport {
  const { building } = input;
  const cal = new Calendar(building.calendar);
  const ahStart = parseClock(building.afterHoursStart);
  const ahEarly = parseClock(building.workdayStart);
  const floorLabel = new Map(input.floors.map((f) => [f.id, f.label]));
  const leases: readonly LeaseSpan[] =
    input.leases ??
    input.floors
      .filter((f) => f.tenantId)
      .map((f) => ({ floorId: f.id, startsOn: "0000-01-01", endsOn: null }));
  const parties = emptyPartyTotals();
  const byFloor = new Map<
    string,
    { kwh: number; afterHoursKwh: number; avoidableKwh: number; tenantKwh: number; buildingKwh: number }
  >();
  const byType = new Map<DayType, { days: Set<string>; kwh: number; avoidableKwh: number }>();
  for (const t of ["workday", "weekend", "holiday"] as DayType[])
    byType.set(t, { days: new Set(), kwh: 0, avoidableKwh: 0 });

  let kwh = 0;
  let afterHours = 0;
  let cost = 0;
  let measured = 0;
  for (const iv of input.intervals) {
    if (iv.start < input.from || iv.start >= input.to) continue;
    const e = totalKwh(iv);
    const local = localParts(iv.start, building.timezone);
    const type = cal.dayType(local.dateKey);
    const isAfter = type !== "workday" || local.minuteOfDay >= ahStart || local.minuteOfDay < ahEarly;
    kwh += e;
    cost += e * priceAt(building.tariff, iv.start, building.timezone);
    if (iv.tier === "measured") measured += e;
    if (isAfter) afterHours += e;
    const split = splitByParty(iv.kwh, leasedOn(leases, iv.floorId, local.dateKey));
    parties.tenant.kwh += split.tenant;
    parties.building.kwh += split.building;
    const f = byFloor.get(iv.floorId) ?? {
      kwh: 0,
      afterHoursKwh: 0,
      avoidableKwh: 0,
      tenantKwh: 0,
      buildingKwh: 0,
    };
    f.kwh += e;
    f.tenantKwh += split.tenant;
    f.buildingKwh += split.building;
    if (isAfter) f.afterHoursKwh += e;
    byFloor.set(iv.floorId, f);
    const t = byType.get(type)!;
    t.days.add(local.dateKey);
    t.kwh += e;
  }

  let avoidable = 0;
  let avoidableCost = 0;
  const byRule = new Map<RuleId, { count: number; kwh: number }>();
  for (const f of input.findings) {
    if (f.start < input.from || f.start >= input.to) continue;
    avoidable += f.avoidableKwh;
    avoidableCost += priceFinding(f, building, input.locationFactor).avoidableCost;
    const fl = byFloor.get(f.floorId);
    if (fl) fl.avoidableKwh += f.avoidableKwh;
    const leased = leasedOn(leases, f.floorId, localParts(f.start, building.timezone).dateKey);
    parties[findingParty(f.ruleId, leased)].avoidableKwh += f.avoidableKwh;
    byType.get(f.dayType)!.avoidableKwh += f.avoidableKwh;
    const r = byRule.get(f.ruleId) ?? { count: 0, kwh: 0 };
    r.count++;
    r.kwh += f.avoidableKwh;
    byRule.set(f.ruleId, r);
  }

  const s2 = scope2(kwh, input.locationFactor, input.instruments, input.residualFactor);
  const dayTypes = { workday: 0, weekend: 0, holiday: 0 } as Record<DayType, number>;
  for (const [t, v] of byType) dayTypes[t] = v.days.size;

  const disclosures = reportDisclosures(
    input.locationFactor,
    input.residualFactor,
    kwh ? measured / kwh : 0,
    {
      simulated: input.simulated,
    },
  );

  return {
    period: {
      from: input.from,
      to: input.to,
      days: dayTypes.workday + dayTypes.weekend + dayTypes.holiday,
      dayTypes,
    },
    totals: {
      kwh: round(kwh, 1),
      afterHoursKwh: round(afterHours, 1),
      cost: round(cost, 2),
      avoidableKwh: round(avoidable, 1),
      avoidableCost: round(avoidableCost, 2),
      avoidableShare: kwh > 0 ? avoidable / kwh : 0,
      measuredShare: kwh > 0 ? measured / kwh : 0,
    },
    scope2: s2,
    avoidableCo2eKg: round(avoidable * input.locationFactor.kgPerKwh, 1),
    byFloor: [...byFloor.entries()]
      .map(([floorId, v]) => ({
        floorId,
        label: floorLabel.get(floorId) ?? floorId,
        kwh: round(v.kwh, 1),
        afterHoursKwh: round(v.afterHoursKwh, 1),
        avoidableKwh: round(v.avoidableKwh, 1),
        tenantKwh: round(v.tenantKwh, 1),
        buildingKwh: round(v.buildingKwh, 1),
        // every interval carries its split by system
        unsplitKwh: 0,
      }))
      .sort((a, b) => b.avoidableKwh - a.avoidableKwh),
    byParty: partyRows(parties),
    partyUnsplit: partyUnsplitRow(parties, 0, 0),
    byDayType: [...byType.entries()].map(([dayType, v]) => ({
      dayType,
      days: v.days.size,
      kwh: round(v.kwh, 1),
      avoidableKwh: round(v.avoidableKwh, 1),
    })),
    byRule: [...byRule.entries()].map(([ruleId, v]) => ({
      ruleId,
      name: RULES[ruleId].name,
      kind: RULES[ruleId].kind,
      count: v.count,
      kwh: round(v.kwh, 1),
    })),
    disclosures,
  };
}
