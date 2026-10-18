import {
  Calendar,
  DEFAULT_RULE_PARAMS,
  type HvacEvent,
  type HvacMode,
  inWindow,
  type LightingEvent,
  localParts,
  MINUTE,
  type OccupancyPoint,
  parseClock,
  type RuleParams,
} from "@flowcarbon/core";
import type { SimOvertime } from "./simulate";
import type { SimBuilding } from "./tower";

/** A control strategy running on one floor of the simulated tower from `from` on (a measure put into effect). */
export interface SimControl {
  /** simulator floor id */
  floorId: string;
  strategy: "occupancy_gated_workday" | "zone_only_non_working" | "auto_lights_off";
  from: number;
  /** when it was taken out again (a cancelled measure), if it was */
  to?: number;
}

const SECURITY_LIGHTING = 0.1;

interface Span<T> {
  from: number;
  to: number;
  value: T;
}

/**
 * Rewrites the BMS and lighting events of controlled floors so the simulated tower behaves as if the strategies
 * were installed: each 15-minute bucket after a control starts is decided from the people counted on the floor,
 * with the same grace periods and thresholds the rules check. Buckets the strategy leaves alone keep the as-is
 * schedule, and nothing before `from` changes, so a re-simulated day keeps the data already ingested.
 */
export function applyControls(
  sb: SimBuilding,
  sim: { from: number; to: number; hvacEvents: HvacEvent[]; lightingEvents: LightingEvent[] },
  occupancy: Map<string, OccupancyPoint[]>,
  overtime: readonly SimOvertime[],
  controls: readonly SimControl[],
  opts: { bucketMinutes: number; params?: Partial<RuleParams> },
): { hvacEvents: HvacEvent[]; lightingEvents: LightingEvent[] } {
  const p: RuleParams = { ...DEFAULT_RULE_PARAMS, ...opts.params };
  const tz = sb.building.timezone;
  const cal = new Calendar(sb.building.calendar);
  const dayStart = parseClock(sb.building.workdayStart);
  const afterHours = parseClock(sb.building.afterHoursStart);
  const startupFrom = (dayStart - p.startupWindowMinutes + 1440) % 1440;
  const startupTo = (dayStart + p.startupWindowMinutes) % 1440;
  const nightStart = parseClock(p.lightsNightStart);
  const nightEnd = parseClock(p.lightsNightEnd);
  const bucket = opts.bucketMinutes * MINUTE;

  let hvacEvents = sim.hvacEvents;
  let lightingEvents = sim.lightingEvents;
  for (const floorId of new Set(controls.map((c) => c.floorId))) {
    const mine = controls.filter((c) => c.floorId === floorId);
    const on = (strategy: SimControl["strategy"], ts: number) =>
      mine.some((c) => c.strategy === strategy && ts >= c.from && ts < (c.to ?? Number.POSITIVE_INFINITY));
    const first = Math.min(...mine.map((c) => c.from));

    const hvacOwn = hvacEvents.filter((e) => e.floorId === floorId).sort((a, b) => a.ts - b.ts);
    const lightOwn = lightingEvents.filter((e) => e.floorId === floorId).sort((a, b) => a.ts - b.ts);
    const people = new Map((occupancy.get(floorId) ?? []).map((o) => [o.start, o.count]));
    const requests = overtime.filter((o) => o.floorId === floorId);

    const hvacSpans: Span<HvacMode>[] = [];
    const lightSpans: Span<number>[] = [];
    let emptyMinutes = 0;
    let darkMinutes = 0;
    for (let s = sim.from; s < sim.to; s += bucket) {
      const count = people.get(s) ?? 0;
      emptyMinutes = count === 0 ? emptyMinutes + opts.bucketMinutes : 0;
      if (s < first) continue;
      const local = localParts(s, tz);
      const workday = cal.dayType(local.dateKey) === "workday";
      const asIs = last(hvacOwn, s)?.mode ?? "off";
      let mode = asIs;
      if (
        workday &&
        on("occupancy_gated_workday", s) &&
        asIs !== "off" &&
        !inWindow(local.minuteOfDay, startupFrom, startupTo)
      ) {
        if (count === 0) {
          if (emptyMinutes > p.emptyGraceMinutes) mode = "off";
        } else if (
          count < p.fullFloorMinPeople &&
          asIs === "full" &&
          !inWindow(local.minuteOfDay, dayStart, afterHours)
        )
          mode = "setback";
      }
      if (!workday && on("zone_only_non_working", s)) {
        // only the floor's own approved request is served, sized by the people it expects
        const own = requests.find((r) => s >= r.start && s < r.start + r.hours * 60 * MINUTE);
        if (!own) mode = "off";
        else if (count === 0 && emptyMinutes > p.emptyGraceMinutes) mode = "off";
        else mode = own.expectedPeople >= p.fullFloorMinPeople ? "full" : "setback";
      }
      if (mode !== asIs) extend(hvacSpans, s, s + bucket, mode);

      const level = last(lightOwn, s)?.level ?? SECURITY_LIGHTING;
      const dark =
        count === 0 && level >= p.lightsMinLevel && inWindow(local.minuteOfDay, nightStart, nightEnd);
      darkMinutes = dark ? darkMinutes + opts.bucketMinutes : 0;
      if (on("auto_lights_off", s) && dark && darkMinutes > p.lightsGraceMinutes)
        extend(lightSpans, s, s + bucket, SECURITY_LIGHTING);
    }
    hvacEvents = override(hvacEvents, hvacOwn, floorId, hvacSpans, (ts, mode) => ({ floorId, ts, mode }));
    lightingEvents = override(lightingEvents, lightOwn, floorId, lightSpans, (ts, level) => ({
      floorId,
      ts,
      level,
    }));
  }
  return { hvacEvents, lightingEvents };
}

/** the last event at or before `ts` in a list sorted by time */
function last<E extends { ts: number }>(sorted: readonly E[], ts: number): E | undefined {
  let found: E | undefined;
  for (const e of sorted) {
    if (e.ts > ts) break;
    found = e;
  }
  return found;
}

function extend<T>(spans: Span<T>[], from: number, to: number, value: T) {
  const tail = spans.at(-1);
  if (tail && tail.to === from && tail.value === value) tail.to = to;
  else spans.push({ from, to, value });
}

/**
 * Replaces a floor's events inside each span with one event setting the span's value, and hands the floor back
 * its as-is state where a span ends.
 */
function override<E extends { floorId: string; ts: number }, T>(
  events: E[],
  own: readonly E[],
  floorId: string,
  spans: readonly Span<T>[],
  make: (ts: number, value: T) => E,
): E[] {
  if (!spans.length) return events;
  const inside = (ts: number) => spans.some((s) => ts >= s.from && ts < s.to);
  const out = events.filter((e) => e.floorId !== floorId || !inside(e.ts));
  for (const s of spans) {
    out.push(make(s.from, s.value));
    if (spans.some((o) => o.from === s.to)) continue;
    const back = last(own, s.to);
    if (back && back.ts !== s.to) out.push({ ...back, ts: s.to });
  }
  return out.sort((a, b) => a.ts - b.ts);
}
