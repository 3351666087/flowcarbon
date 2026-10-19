import {
  addDays,
  type BuildingProfile,
  buildFloorIntervals,
  Calendar,
  DAY,
  detectFindings,
  type FloorInterval,
  floorDayStats,
  HOUR,
  type HvacMode,
  localParts,
  MINUTE,
  type OvertimeWindow,
  occupancyFromDoorCounts,
  priceAt,
  priceFinding,
  totalKwh,
  zonedTime,
} from "@flowcarbon/core";
import { schema, type Tx } from "@flowcarbon/db";
import { and, eq, gt, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { type BuildingContext, locationFactorFor } from "./context";

/** Local-day window [from, to) covering the given dates, in epoch ms. */
export function dayWindow(
  b: BuildingProfile,
  fromDate: string,
  toDateExclusive: string,
): { from: number; to: number } {
  return { from: zonedTime(fromDate, 0, b.timezone), to: zonedTime(toDateExclusive, 0, b.timezone) };
}

export function localDate(b: BuildingProfile, ts: number): string {
  return localParts(ts, b.timezone).dateKey;
}

const BATCH = 2_000;

async function insertChunks<T>(rows: T[], fn: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) await fn(rows.slice(i, i + BATCH));
}

/**
 * How far from a floor's nearest telemetry an interval may still be built. Beyond it the floor is not reporting
 * (a gateway down, or an imported dataset that has ended), and carrying the last known state forward would invent
 * hours or whole days of use. Matches the data page's "silent for 2 hours".
 */
const REPORTING_GAP = 2 * HOUR;

/**
 * Rebuilds floor intervals and daily roll-ups for [from, to) from raw telemetry, only where the floor reported.
 * Idempotent: running it twice over the same window yields the same rows.
 */
export async function recomputeIntervals(
  tx: Tx,
  ctx: BuildingContext,
  from: number,
  to: number,
): Promise<FloorInterval[]> {
  const floorIds = ctx.floors.map((f) => f.id);
  if (floorIds.length === 0) return [];
  // door counts need a day of history so the running headcount is right at `from`
  const lookback = from - DAY;

  const devices = await tx
    .select()
    .from(schema.devices)
    .where(eq(schema.devices.buildingId, ctx.building.id));
  const deviceFloor = new Map(devices.map((d) => [d.id, d.floorId]));
  const meterSystem = new Map(devices.filter((d) => d.kind === "meter").map((d) => [d.id, d.system]));

  const [doors, readings, hvac, lights] = await Promise.all([
    tx
      .select()
      .from(schema.doorCounts)
      .where(
        and(
          inArray(schema.doorCounts.floorId, floorIds),
          gte(schema.doorCounts.startAt, new Date(lookback)),
          lt(schema.doorCounts.startAt, new Date(to)),
        ),
      ),
    tx
      .select()
      .from(schema.energyReadings)
      .where(
        and(
          inArray(
            schema.energyReadings.deviceId,
            [...meterSystem.keys()].length
              ? [...meterSystem.keys()]
              : ["00000000-0000-0000-0000-000000000000"],
          ),
          lt(schema.energyReadings.startAt, new Date(to)),
          gt(schema.energyReadings.endAt, new Date(from)),
        ),
      ),
    tx
      .select()
      .from(schema.hvacEvents)
      .where(
        and(
          inArray(schema.hvacEvents.floorId, floorIds),
          gte(schema.hvacEvents.at, new Date(from)),
          lt(schema.hvacEvents.at, new Date(to)),
        ),
      ),
    tx
      .select()
      .from(schema.lightingEvents)
      .where(
        and(
          inArray(schema.lightingEvents.floorId, floorIds),
          gte(schema.lightingEvents.at, new Date(from)),
          lt(schema.lightingEvents.at, new Date(to)),
        ),
      ),
  ]);

  // state in force at `from`: the last event before the window, per floor
  const initialHvac = new Map<string, HvacMode>();
  const initialLight = new Map<string, number>();
  const priorHvac = await tx.execute<{ floor_id: string; mode: HvacMode; at: string }>(sql`
    select distinct on (floor_id) floor_id, mode, at from ${schema.hvacEvents}
    where floor_id in ${floorIds} and at < ${new Date(from).toISOString()}::timestamptz order by floor_id, at desc`);
  for (const r of priorHvac) initialHvac.set(r.floor_id, r.mode);
  const priorLight = await tx.execute<{ floor_id: string; level: number; at: string }>(sql`
    select distinct on (floor_id) floor_id, level, at from ${schema.lightingEvents}
    where floor_id in ${floorIds} and at < ${new Date(from).toISOString()}::timestamptz order by floor_id, at desc`);
  for (const r of priorLight) initialLight.set(r.floor_id, r.level);

  // when each floor reported anything at all, to keep intervals to the time it was reporting
  const reported = new Map<string, number[]>();
  const saw = (floorId: string | null | undefined, ts: number) => {
    if (!floorId) return;
    const list = reported.get(floorId) ?? [];
    list.push(ts);
    reported.set(floorId, list);
  };
  for (const d of doors) saw(d.floorId, d.startAt.getTime());
  for (const r of readings) {
    saw(deviceFloor.get(r.deviceId), r.startAt.getTime());
    saw(deviceFloor.get(r.deviceId), r.endAt.getTime());
  }
  for (const e of hvac) saw(e.floorId, e.at.getTime());
  for (const e of lights) saw(e.floorId, e.at.getTime());
  for (const r of [...priorHvac, ...priorLight]) saw(r.floor_id, new Date(r.at).getTime());
  for (const list of reported.values()) list.sort((a, b) => a - b);
  const wasReporting = (floorId: string, start: number, end: number) => {
    const list = reported.get(floorId);
    if (!list) return false;
    // the first report at or after start - gap; the interval counts if it is no later than end + gap
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]! < start - REPORTING_GAP) lo = mid + 1;
      else hi = mid;
    }
    return lo < list.length && list[lo]! <= end + REPORTING_GAP;
  };

  const occ = occupancyFromDoorCounts(
    doors.map((d) => ({
      floorId: d.floorId,
      start: d.startAt.getTime(),
      entries: d.entries,
      exits: d.exits,
    })),
    { timeZone: ctx.building.timezone, bucketMinutes: ctx.bucketMinutes },
  );
  const occupancy = [...occ].flatMap(([floorId, pts]) =>
    pts
      .filter((p) => p.start >= from - ctx.bucketMinutes * MINUTE)
      .map((p) => ({ floorId, ts: p.start, count: p.count })),
  );

  const hvacEvents = [
    ...[...initialHvac].map(([floorId, mode]) => ({ floorId, ts: from, mode })),
    ...hvac.map((e) => ({ floorId: e.floorId, ts: e.at.getTime(), mode: e.mode })),
  ];
  const lightingEvents = [
    ...[...initialLight].map(([floorId, level]) => ({ floorId, ts: from, level })),
    ...lights.map((e) => ({ floorId: e.floorId, ts: e.at.getTime(), level: e.level })),
  ];
  const energy = readings.flatMap((r) => {
    const floorId = deviceFloor.get(r.deviceId);
    const system = meterSystem.get(r.deviceId);
    return floorId && system
      ? [{ floorId, system, start: r.startAt.getTime(), end: r.endAt.getTime(), kwh: r.kwh }]
      : [];
  });

  const intervals = buildFloorIntervals({
    floors: ctx.floors,
    from,
    to,
    bucketMinutes: ctx.bucketMinutes,
    readings: energy,
    hvacEvents,
    lightingEvents,
    occupancy,
  }).filter((i) => wasReporting(i.floorId, i.start, i.start + i.minutes * MINUTE));

  // the window is rebuilt from scratch, so time that no longer has data (or never had) leaves no rows behind
  await tx
    .delete(schema.floorIntervals)
    .where(
      and(
        eq(schema.floorIntervals.buildingId, ctx.building.id),
        gte(schema.floorIntervals.startAt, new Date(from)),
        lt(schema.floorIntervals.startAt, new Date(to)),
      ),
    );
  await tx
    .delete(schema.floorDaily)
    .where(
      and(
        eq(schema.floorDaily.buildingId, ctx.building.id),
        gte(schema.floorDaily.day, localDate(ctx.building, from)),
        lte(schema.floorDaily.day, localDate(ctx.building, to - 1)),
      ),
    );

  const rows = intervals.map((i) => ({
    orgId: ctx.orgId,
    buildingId: ctx.building.id,
    floorId: i.floorId,
    startAt: new Date(i.start),
    minutes: i.minutes,
    occupancy: i.occupancy,
    hvacOn: i.hvacOn,
    hvacMode: i.hvacMode,
    lightsOn: i.lightsOn,
    kwhHvac: i.kwh.hvac,
    kwhLighting: i.kwh.lighting,
    kwhPlug: i.kwh.plug,
    tier: i.tier,
  }));
  await insertChunks(rows, (chunk) =>
    tx
      .insert(schema.floorIntervals)
      .values(chunk)
      .onConflictDoUpdate({
        target: [schema.floorIntervals.floorId, schema.floorIntervals.startAt],
        set: {
          minutes: sql`excluded.minutes`,
          occupancy: sql`excluded.occupancy`,
          hvacOn: sql`excluded.hvac_on`,
          hvacMode: sql`excluded.hvac_mode`,
          lightsOn: sql`excluded.lights_on`,
          kwhHvac: sql`excluded.kwh_hvac`,
          kwhLighting: sql`excluded.kwh_lighting`,
          kwhPlug: sql`excluded.kwh_plug`,
          tier: sql`excluded.tier`,
          computedAt: sql`now()`,
        },
      }),
  );
  await writeDailyRollups(tx, ctx, intervals);
  return intervals;
}

async function writeDailyRollups(
  tx: Tx,
  ctx: BuildingContext,
  intervals: readonly FloorInterval[],
): Promise<void> {
  const stats = floorDayStats(ctx.building, intervals);
  const extra = new Map<string, { cost: number; measured: number; n: number }>();
  for (const iv of intervals) {
    const key = `${iv.floorId}|${localDate(ctx.building, iv.start)}`;
    const e = extra.get(key) ?? { cost: 0, measured: 0, n: 0 };
    const kwh = totalKwh(iv);
    e.cost += kwh * priceAt(ctx.building.tariff, iv.start, ctx.building.timezone);
    if (iv.tier === "measured") e.measured += kwh;
    e.n++;
    extra.set(key, e);
  }
  const rows = stats.map((s) => {
    const e = extra.get(`${s.floorId}|${s.dateKey}`)!;
    return {
      orgId: ctx.orgId,
      buildingId: ctx.building.id,
      floorId: s.floorId,
      day: s.dateKey,
      dayType: s.dayType,
      kwhTotal: s.totalKwh,
      kwhAfterHours: s.afterHoursKwh,
      kwhMeasured: e.measured,
      cost: Math.round(e.cost * 100) / 100,
      afterHoursPeak: s.afterHoursPeak,
      afterHoursHvacHours: s.afterHoursHvacHours,
      intervals: e.n,
    };
  });
  await insertChunks(rows, (chunk) =>
    tx
      .insert(schema.floorDaily)
      .values(chunk)
      .onConflictDoUpdate({
        target: [schema.floorDaily.floorId, schema.floorDaily.day],
        set: {
          dayType: sql`excluded.day_type`,
          kwhTotal: sql`excluded.kwh_total`,
          kwhAfterHours: sql`excluded.kwh_after_hours`,
          kwhMeasured: sql`excluded.kwh_measured`,
          cost: sql`excluded.cost`,
          afterHoursPeak: sql`excluded.after_hours_peak`,
          afterHoursHvacHours: sql`excluded.after_hours_hvac_hours`,
          intervals: sql`excluded.intervals`,
          computedAt: sql`now()`,
        },
      }),
  );
}

export async function loadIntervals(
  tx: Tx,
  ctx: BuildingContext,
  from: number,
  to: number,
): Promise<FloorInterval[]> {
  const rows = await tx
    .select()
    .from(schema.floorIntervals)
    .where(
      and(
        eq(schema.floorIntervals.buildingId, ctx.building.id),
        gte(schema.floorIntervals.startAt, new Date(from)),
        lt(schema.floorIntervals.startAt, new Date(to)),
      ),
    );
  return rows.map((r) => ({
    floorId: r.floorId,
    start: r.startAt.getTime(),
    minutes: r.minutes,
    occupancy: r.occupancy,
    hvacOn: r.hvacOn,
    hvacMode: r.hvacMode,
    lightsOn: r.lightsOn,
    kwh: { hvac: r.kwhHvac, lighting: r.kwhLighting, plug: r.kwhPlug },
    tier: r.tier,
  }));
}

export async function approvedOvertime(
  tx: Tx,
  ctx: BuildingContext,
  from: number,
  to: number,
): Promise<OvertimeWindow[]> {
  const rows = await tx
    .select()
    .from(schema.overtimeRequests)
    .where(
      and(
        eq(schema.overtimeRequests.buildingId, ctx.building.id),
        eq(schema.overtimeRequests.status, "approved"),
        lt(schema.overtimeRequests.startAt, new Date(to)),
        gte(schema.overtimeRequests.startAt, new Date(from - DAY)),
      ),
    );
  return rows.map((r) => ({
    floorId: r.floorId,
    start: r.startAt.getTime(),
    end: r.startAt.getTime() + r.hours * 3_600_000,
    mode: r.approvedMode === "setback" ? "setback" : "full",
  }));
}

export interface DetectResult {
  upserted: number;
  removed: number;
  avoidableKwh: number;
}

/**
 * Runs the rules over [from, to) (with a day of context before it) and reconciles the stored findings:
 * new findings are inserted, changed ones updated, and open findings that no longer hold (late data) removed.
 * Findings a person has already reviewed are never deleted.
 */
export async function detectAndStore(
  tx: Tx,
  ctx: BuildingContext,
  from: number,
  to: number,
): Promise<DetectResult> {
  const context = from - DAY;
  const intervals = await loadIntervals(tx, ctx, context, to);
  const windows = await approvedOvertime(tx, ctx, context, to);
  const factor = locationFactorFor(ctx, new Date(to).getUTCFullYear());
  const found = detectFindings({
    building: ctx.building,
    floors: ctx.floors,
    intervals,
    approvedOvertime: windows,
    params: ctx.ruleParams,
  }).filter((f) => f.start >= from && f.start < to);

  const params = { ...ctx.ruleParams };
  const rows = found.map((f) => {
    const p = priceFinding(f, ctx.building, factor);
    return {
      orgId: ctx.orgId,
      buildingId: ctx.building.id,
      floorId: f.floorId,
      ruleId: f.ruleId,
      kind: f.kind,
      startAt: new Date(f.start),
      endAt: new Date(f.end),
      dayType: f.dayType,
      avoidableKwh: f.avoidableKwh,
      avoidableCost: p.avoidableCost,
      avoidableCo2eKg: p.avoidableCo2eKg,
      peakPeople: f.peakPeople,
      tier: f.tier,
      evidence: f.evidence,
      params,
    };
  });
  await insertChunks(rows, (chunk) =>
    tx
      .insert(schema.findings)
      .values(chunk)
      .onConflictDoUpdate({
        target: [schema.findings.floorId, schema.findings.ruleId, schema.findings.startAt],
        set: {
          endAt: sql`excluded.end_at`,
          avoidableKwh: sql`excluded.avoidable_kwh`,
          avoidableCost: sql`excluded.avoidable_cost`,
          avoidableCo2eKg: sql`excluded.avoidable_co2e_kg`,
          peakPeople: sql`excluded.peak_people`,
          tier: sql`excluded.tier`,
          evidence: sql`excluded.evidence`,
          params: sql`excluded.params`,
        },
      }),
  );

  const keep = new Set(rows.map((r) => `${r.floorId}|${r.ruleId}|${r.startAt.getTime()}`));
  const existing = await tx
    .select({
      id: schema.findings.id,
      floorId: schema.findings.floorId,
      ruleId: schema.findings.ruleId,
      startAt: schema.findings.startAt,
    })
    .from(schema.findings)
    .where(
      and(
        eq(schema.findings.buildingId, ctx.building.id),
        eq(schema.findings.status, "open"),
        gte(schema.findings.startAt, new Date(from)),
        lt(schema.findings.startAt, new Date(to)),
      ),
    );
  const stale = existing
    .filter((e) => !keep.has(`${e.floorId}|${e.ruleId}|${e.startAt.getTime()}`))
    .map((e) => e.id);
  if (stale.length) await tx.delete(schema.findings).where(inArray(schema.findings.id, stale));

  // avoidable energy per floor and day into the roll-up. A finding that runs past midnight counts on each day in
  // proportion to the energy its floor used in that part of it; since a finding's avoidable energy never exceeds the
  // energy of its own intervals, no day shows more avoidable energy than it used. Findings that began before the
  // window still add their share to the days in it.
  const cal = new Calendar(ctx.building.calendar);
  const perDay = new Map<string, number>();
  const overlapping = await tx
    .select({
      floorId: schema.findings.floorId,
      startAt: schema.findings.startAt,
      endAt: schema.findings.endAt,
      avoidableKwh: schema.findings.avoidableKwh,
    })
    .from(schema.findings)
    .where(
      and(
        eq(schema.findings.buildingId, ctx.building.id),
        lt(schema.findings.startAt, new Date(to)),
        gt(schema.findings.endAt, new Date(from)),
      ),
    );
  const spanFrom = Math.min(from, ...overlapping.map((f) => f.startAt.getTime()));
  const spanTo = Math.max(to, ...overlapping.map((f) => f.endAt.getTime()));
  const used = await loadIntervals(tx, ctx, spanFrom, spanTo);
  const byFloor = new Map<string, FloorInterval[]>();
  for (const iv of used) {
    const list = byFloor.get(iv.floorId);
    if (list) list.push(iv);
    else byFloor.set(iv.floorId, [iv]);
  }
  for (const f of overlapping) {
    const start = f.startAt.getTime();
    const end = Math.max(f.endAt.getTime(), start + 1);
    const days = new Map<string, number>();
    let energy = 0;
    for (const iv of byFloor.get(f.floorId) ?? []) {
      if (iv.start < start || iv.start >= end) continue;
      const kwh = totalKwh(iv);
      energy += kwh;
      const day = localDate(ctx.building, iv.start);
      days.set(day, (days.get(day) ?? 0) + kwh);
    }
    // no stored intervals under it (should not happen): the day it started on carries it
    if (energy <= 0) {
      energy = 1;
      days.set(localDate(ctx.building, start), 1);
    }
    for (const [day, kwh] of days) {
      if (day < localDate(ctx.building, from) || day > localDate(ctx.building, to - 1)) continue;
      const key = `${f.floorId}|${day}`;
      perDay.set(key, (perDay.get(key) ?? 0) + (f.avoidableKwh * kwh) / energy);
    }
  }
  const firstDay = localDate(ctx.building, from);
  const lastDay = localDate(ctx.building, to - 1);
  await tx
    .update(schema.floorDaily)
    .set({ avoidableKwh: 0 })
    .where(
      and(
        eq(schema.floorDaily.buildingId, ctx.building.id),
        gte(schema.floorDaily.day, firstDay),
        lte(schema.floorDaily.day, lastDay),
      ),
    );
  for (const [key, kwh] of perDay) {
    const [floorId, day] = key.split("|") as [string, string];
    await tx
      .update(schema.floorDaily)
      .set({ avoidableKwh: kwh, dayType: cal.dayType(day) })
      .where(and(eq(schema.floorDaily.floorId, floorId), eq(schema.floorDaily.day, day)));
  }
  return {
    upserted: rows.length,
    removed: stale.length,
    avoidableKwh: found.reduce((s, f) => s + f.avoidableKwh, 0),
  };
}

/** Full pipeline for whole local days: intervals → roll-ups → findings. */
export async function processDays(
  tx: Tx,
  ctx: BuildingContext,
  fromDate: string,
  toDateExclusive: string,
  now = Date.now(),
) {
  const window = dayWindow(ctx.building, fromDate, toDateExclusive);
  // never build intervals for time that has not happened yet; today is processed up to the last whole bucket
  const bucket = ctx.bucketMinutes * MINUTE;
  const to = Math.min(window.to, Math.floor(now / bucket) * bucket);
  const from = window.from;
  // intervals beyond "now" can only be left over from a clock or data error; they must not count
  await tx
    .delete(schema.floorIntervals)
    .where(
      and(
        eq(schema.floorIntervals.buildingId, ctx.building.id),
        gte(schema.floorIntervals.startAt, new Date(Math.max(from, to))),
        lt(schema.floorIntervals.startAt, new Date(window.to)),
      ),
    );
  if (to <= from) return { intervals: 0, upserted: 0, removed: 0, avoidableKwh: 0, days: 0 };
  const intervals = await recomputeIntervals(tx, ctx, from, to);
  const detect = await detectAndStore(tx, ctx, from, to);
  return { intervals: intervals.length, ...detect, days: Math.ceil((to - from) / DAY) };
}

export { addDays };
