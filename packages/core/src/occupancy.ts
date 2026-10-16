import { localParts } from "./time";

/** Entries and exits counted at a floor's doors (or lobby gates) during one bucket. */
export interface DoorCount {
  floorId: string;
  start: number;
  entries: number;
  exits: number;
}

export interface OccupancyPoint {
  start: number;
  /** estimated people on the floor at the end of the bucket */
  count: number;
  /** people still "on the floor" at the nightly reset, i.e. counter drift (data-quality signal) */
  driftCorrected?: number;
}

export interface OccupancyOptions {
  timeZone: string;
  /**
   * Local minute of day at which the running count is reset to zero if no entries were seen
   * in that bucket. Door counters drift (tailgating, missed exits); a nightly reset bounds the error.
   * Default 04:00.
   */
  resetMinuteOfDay?: number;
  bucketMinutes?: number;
  /**
   * Night-time idle decay: between `idleFrom` and `idleTo` (local minutes), a small residual count
   * (≤ idleMaxCount) with no movement for `idleMinutes` is treated as missed exits and cleared.
   * Defaults: 21:00–06:00, 120 min, 3 people.
   */
  idleFrom?: number;
  idleTo?: number;
  idleMinutes?: number;
  idleMaxCount?: number;
}

/**
 * Turns door counts into a running headcount per floor.
 * Never goes negative; resets once per night and reports how much drift it removed.
 */
export function occupancyFromDoorCounts(
  counts: readonly DoorCount[],
  opts: OccupancyOptions,
): Map<string, OccupancyPoint[]> {
  const reset = opts.resetMinuteOfDay ?? 240;
  const bucket = opts.bucketMinutes ?? 15;
  const idleFrom = opts.idleFrom ?? 21 * 60;
  const idleTo = opts.idleTo ?? 6 * 60;
  const idleMinutes = opts.idleMinutes ?? 120;
  const idleMax = opts.idleMaxCount ?? 3;
  const byFloor = new Map<string, DoorCount[]>();
  for (const c of counts) {
    const list = byFloor.get(c.floorId);
    if (list) list.push(c);
    else byFloor.set(c.floorId, [c]);
  }
  const out = new Map<string, OccupancyPoint[]>();
  for (const [floorId, list] of byFloor) {
    list.sort((a, b) => a.start - b.start);
    let running = 0;
    let idle = 0;
    const points: OccupancyPoint[] = [];
    for (const c of list) {
      const minute = localParts(c.start, opts.timeZone).minuteOfDay;
      const isResetBucket = minute <= reset && reset < minute + bucket;
      const night =
        idleFrom <= idleTo ? minute >= idleFrom && minute < idleTo : minute >= idleFrom || minute < idleTo;
      idle = c.entries === 0 && c.exits === 0 ? idle + bucket : 0;
      let driftCorrected: number | undefined;
      if (
        running > 0 &&
        c.entries === 0 &&
        (isResetBucket || (night && idle >= idleMinutes && running <= idleMax))
      ) {
        driftCorrected = running;
        running = 0;
      }
      running = Math.max(0, running + c.entries - c.exits);
      points.push(
        driftCorrected === undefined
          ? { start: c.start, count: running }
          : { start: c.start, count: running, driftCorrected },
      );
    }
    out.set(floorId, points);
  }
  return out;
}
