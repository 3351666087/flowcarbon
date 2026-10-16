import type { WorkCalendar } from "./calendar";
import type { Tariff } from "./tariff";

/** How a number was obtained. Every energy figure carries its tier so estimates are never shown as measurements. */
export type DataTier = "measured" | "estimated";

export type HvacMode = "off" | "setback" | "full";

export interface BuildingProfile {
  id: string;
  name: string;
  /** IANA time zone, e.g. "Asia/Shanghai" */
  timezone: string;
  currency: string;
  /** Normal occupied hours on working days, local "HH:MM" */
  workdayStart: string;
  /** Start of "after hours" on working days, local "HH:MM" */
  afterHoursStart: string;
  tariff: Tariff;
  calendar: WorkCalendar;
  /** Grid region used to pick a location-based emission factor, e.g. "CN-East" */
  gridRegion: string;
}

export interface FloorProfile {
  id: string;
  label: string;
  level: number;
  areaM2: number;
  tenantId: string | null;
  /** Rated cooling power drawn for this floor when its zone runs at full load (kW electric) */
  ratedHvacKw: number;
  /** Rated lighting power of the floor at 100 % (kW) */
  ratedLightingKw: number;
  /** Plug load per person present (kW) */
  plugKwPerPerson: number;
  /**
   * Share of the floor's full cooling load used when only a zone is conditioned (setback / zone-only).
   * Default 0.3 — order-of-magnitude assumption to verify per building.
   */
  zoneOnlyFraction?: number;
}

export interface TenantProfile {
  id: string;
  name: string;
  /** Overtime cooling fee charged per hour per floor */
  overtimeRatePerHour: number;
}

/** One time bucket (default 15 min) of one floor, after aggregation of raw telemetry. */
export interface FloorInterval {
  floorId: string;
  /** epoch ms, interval start */
  start: number;
  minutes: number;
  /** peak number of people on the floor during the interval */
  occupancy: number;
  /** fraction of the interval the floor's HVAC zone was running (0..1) */
  hvacOn: number;
  /** dominant HVAC mode in the interval */
  hvacMode: HvacMode;
  /** average lighting level (0..1) */
  lightsOn: number;
  kwh: { hvac: number; lighting: number; plug: number };
  tier: DataTier;
}

/** An approved overtime window: cooling the tenant asked (and paid) for. */
export interface OvertimeWindow {
  floorId: string;
  start: number;
  end: number;
  mode: Exclude<HvacMode, "off">;
}

export function intervalEnd(i: FloorInterval): number {
  return i.start + i.minutes * 60_000;
}

export function totalKwh(i: FloorInterval): number {
  return i.kwh.hvac + i.kwh.lighting + i.kwh.plug;
}

export function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
