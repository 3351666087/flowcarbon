import type { DataTier, FloorInterval, FloorProfile, HvacMode } from "./model";
import { MINUTE } from "./time";

export type MeterSystem = "hvac" | "lighting" | "plug" | "total";

/** Energy reported by a meter for a period (already converted from register deltas). */
export interface EnergyReading {
  floorId: string;
  system: MeterSystem;
  start: number;
  end: number;
  kwh: number;
}

/** A state change of the HVAC zone serving a floor, e.g. from the BMS. */
export interface HvacEvent {
  floorId: string;
  ts: number;
  mode: HvacMode;
}

/** A change of the floor's lighting level (0..1), e.g. from a lighting controller or circuit monitor. */
export interface LightingEvent {
  floorId: string;
  ts: number;
  level: number;
}

export interface OccupancySample {
  floorId: string;
  ts: number;
  count: number;
}

export interface IntervalBuildInput {
  floors: readonly FloorProfile[];
  from: number;
  to: number;
  bucketMinutes?: number;
  readings?: readonly EnergyReading[];
  hvacEvents?: readonly HvacEvent[];
  lightingEvents?: readonly LightingEvent[];
  occupancy?: readonly OccupancySample[];
  /** state before `from` if no event precedes it */
  initialHvacMode?: HvacMode;
  initialLightingLevel?: number;
}

function groupBy<T extends { floorId: string }>(items: readonly T[] | undefined): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items ?? []) {
    const l = m.get(it.floorId);
    if (l) l.push(it);
    else m.set(it.floorId, [it]);
  }
  return m;
}

/** Integrates a step function given by sorted state changes over [a, b). */
function stepIntegrals<S>(
  events: readonly { ts: number; state: S }[],
  initial: S,
  a: number,
  b: number,
): Map<S, number> {
  const share = new Map<S, number>();
  let state = initial;
  let i = 0;
  while (i < events.length && events[i]!.ts <= a) state = events[i++]!.state;
  let t = a;
  while (t < b) {
    const next = i < events.length ? Math.min(events[i]!.ts, b) : b;
    share.set(state, (share.get(state) ?? 0) + (next - t));
    t = next;
    while (i < events.length && events[i]!.ts <= t) state = events[i++]!.state;
  }
  return share;
}

/** Overlap in ms between [a1,b1) and [a2,b2). */
function overlap(a1: number, b1: number, a2: number, b2: number): number {
  return Math.max(0, Math.min(b1, b2) - Math.max(a1, a2));
}

/**
 * Aggregates raw telemetry into fixed buckets per floor.
 * Measured energy is used wherever a meter covers the floor and system; otherwise energy is estimated
 * from rated power × run time (HVAC, lighting) or people × plug load, and the bucket is tagged "estimated".
 */
export function buildFloorIntervals(input: IntervalBuildInput): FloorInterval[] {
  const bucket = (input.bucketMinutes ?? 15) * MINUTE;
  const readings = groupBy(input.readings);
  const hvac = groupBy(input.hvacEvents);
  const lights = groupBy(input.lightingEvents);
  const occ = groupBy(input.occupancy);
  const out: FloorInterval[] = [];

  for (const floor of input.floors) {
    const fReadings = (readings.get(floor.id) ?? []).slice().sort((x, y) => x.start - y.start);
    const fHvac = (hvac.get(floor.id) ?? [])
      .slice()
      .sort((x, y) => x.ts - y.ts)
      .map((e) => ({ ts: e.ts, state: e.mode }));
    const fLights = (lights.get(floor.id) ?? [])
      .slice()
      .sort((x, y) => x.ts - y.ts)
      .map((e) => ({ ts: e.ts, state: e.level }));
    const fOcc = (occ.get(floor.id) ?? []).slice().sort((x, y) => x.ts - y.ts);
    const metered = new Set(fReadings.map((r) => r.system));
    const zoneFraction = floor.zoneOnlyFraction ?? 0.3;
    let ri = 0;
    let oi = 0;
    let lastCount = 0;

    for (let start = input.from; start < input.to; start += bucket) {
      const end = start + bucket;
      const hours = bucket / 3_600_000;

      const hv = stepIntegrals(fHvac, input.initialHvacMode ?? "off", start, end);
      const fullMs = hv.get("full") ?? 0;
      const setbackMs = hv.get("setback") ?? 0;
      const hvacOn = (fullMs + setbackMs) / bucket;
      const hvacMode: HvacMode = hvacOn === 0 ? "off" : fullMs >= setbackMs ? "full" : "setback";

      const lv = stepIntegrals(fLights, input.initialLightingLevel ?? 0, start, end);
      let lightsOn = 0;
      for (const [level, ms] of lv) lightsOn += level * (ms / bucket);

      // peak headcount: last known count entering the bucket plus every sample inside it
      let peak = lastCount;
      while (oi < fOcc.length && fOcc[oi]!.ts < end) {
        lastCount = fOcc[oi]!.count;
        peak = Math.max(peak, lastCount);
        oi++;
      }

      const measured = { hvac: 0, lighting: 0, plug: 0, total: 0 };
      while (ri < fReadings.length && fReadings[ri]!.end <= start) ri++;
      for (let k = ri; k < fReadings.length && fReadings[k]!.start < end; k++) {
        const r = fReadings[k]!;
        const span = r.end - r.start;
        if (span <= 0) continue;
        measured[r.system] += (r.kwh * overlap(start, end, r.start, r.end)) / span;
      }

      const estHvac = floor.ratedHvacKw * hours * ((fullMs + setbackMs * zoneFraction) / bucket);
      const estLight = floor.ratedLightingKw * hours * lightsOn;
      const estPlug = floor.plugKwPerPerson * hours * peak;

      let tier: DataTier = "measured";
      let kwhHvac = estHvac;
      let kwhLight = estLight;
      let kwhPlug = estPlug;
      if (metered.has("hvac")) kwhHvac = measured.hvac;
      else tier = "estimated";
      if (metered.has("lighting")) kwhLight = measured.lighting;
      else tier = "estimated";
      if (metered.has("plug")) kwhPlug = measured.plug;
      else if (metered.has("total")) {
        // a floor sub-meter without split: plug = total − (hvac + lighting), never negative
        kwhPlug = Math.max(0, measured.total - kwhHvac - kwhLight);
      } else tier = "estimated";

      out.push({
        floorId: floor.id,
        start,
        minutes: bucket / MINUTE,
        occupancy: peak,
        hvacOn,
        hvacMode,
        lightsOn,
        kwh: { hvac: kwhHvac, lighting: kwhLight, plug: kwhPlug },
        tier,
      });
    }
  }
  return out;
}
