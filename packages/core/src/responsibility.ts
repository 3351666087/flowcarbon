import type { RuleId } from "./rules";

/**
 * Who controls a kWh: the tenant, or the building (the property manager's engineering team).
 *
 * This is assigned by system, not by metered area. FlowCarbon meters each office floor per system (cooling,
 * lighting, plug); it has no separate meters for lobbies, corridors, lifts or plant rooms, so it cannot say
 * how much energy the common areas used. What it can say honestly is who switches each load on a floor, which
 * answers the property manager's question "do I call the tenant or engineering?".
 */
export type Party = "tenant" | "building";

/** Who to call about a finding. */
export type Responder = "tenant" | "engineering";

export type MeteredSystem = "hvac" | "lighting" | "plug";

export const PARTIES: readonly Party[] = ["tenant", "building"];

/**
 * The documented default mapping for a leased floor. On a vacant floor every system is the building's.
 * Some buildings let tenants run their own fan coils, or the property switches corridor lighting on tenant
 * floors; a per-building override is a possible follow-up, not part of this default.
 */
export const SYSTEM_PARTY_WHEN_LEASED: Readonly<Record<MeteredSystem, Party>> = {
  hvac: "building",
  lighting: "tenant",
  plug: "tenant",
};

/** Why each system maps the way it does on a leased floor. */
export const SYSTEM_PARTY_RATIONALE: Readonly<Record<MeteredSystem, string>> = {
  hvac: "Cooling comes from the central plant on the BMS schedule, which the property runs; the floor's cooling includes its share of the central plant.",
  lighting: "In-unit lighting is switched by the tenant.",
  plug: "Plug loads are the tenant's own equipment.",
};

/** Printed with every report, right after the boundary. */
export const RESPONSIBILITY_DISCLOSURE =
  "Tenant-controlled vs building-controlled is assigned by system, not by metered area: on a leased floor lighting and plug loads count as the tenant's and cooling (including the floor's share of the central plant) as the building's; on a vacant floor all of it is the building's. Lobbies, corridors, lifts and plant rooms are not metered separately and are not in this report.";

export function partyOf(system: MeteredSystem, leased: boolean): Party {
  return leased ? SYSTEM_PARTY_WHEN_LEASED[system] : "building";
}

/** Splits one floor's per-system kWh between the tenant and the building. The parts add up to the total. */
export function splitByParty(
  kwh: { hvac: number; lighting: number; plug: number },
  leased: boolean,
): Record<Party, number> {
  const out: Record<Party, number> = { tenant: 0, building: 0 };
  for (const s of ["hvac", "lighting", "plug"] as const) out[partyOf(s, leased)] += kwh[s];
  return out;
}

/**
 * Who to call about a finding. The three cooling rules concern the BMS schedule, which the building runs.
 * Lights left on at night are the tenant's on a leased floor and engineering's on a vacant one.
 */
export function findingResponder(ruleId: RuleId | string, leased: boolean): Responder {
  return ruleId === "lights_on_empty_night" && leased ? "tenant" : "engineering";
}

/** The party whose bill a finding's avoidable energy belongs to. */
export function findingParty(ruleId: RuleId | string, leased: boolean): Party {
  return findingResponder(ruleId, leased) === "tenant" ? "tenant" : "building";
}

export interface LeaseSpan {
  floorId: string;
  /** local date, YYYY-MM-DD, inclusive */
  startsOn: string;
  /** local date, YYYY-MM-DD, inclusive; null means open-ended */
  endsOn: string | null;
}

/** True when a lease is in force on the floor on the local date `dateKey`. */
export function leasedOn(leases: readonly LeaseSpan[], floorId: string, dateKey: string): boolean {
  return leases.some(
    (l) => l.floorId === floorId && l.startsOn <= dateKey && (l.endsOn === null || l.endsOn >= dateKey),
  );
}
