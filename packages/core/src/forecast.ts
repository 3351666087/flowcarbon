import { Calendar, type DayType } from "./calendar";
import type { BuildingProfile, FloorInterval, FloorProfile } from "./model";
import { round, totalKwh } from "./model";
import { addDays, isoWeekdayOf, localParts, parseClock } from "./time";

/** Per floor and local date: what happened after hours. */
export interface FloorDayStats {
  floorId: string;
  dateKey: string;
  dayType: DayType;
  /** peak people after the after-hours start on working days; peak of the whole day otherwise */
  afterHoursPeak: number;
  afterHoursHvacHours: number;
  afterHoursKwh: number;
  totalKwh: number;
}

/**
 * @param peakOffsetMinutes the after-hours peak is taken from this long after the after-hours start, so
 *   people on their normal way out (18:00–19:00) are not counted as overtime. Default 60.
 */
export function floorDayStats(
  building: BuildingProfile,
  intervals: readonly FloorInterval[],
  peakOffsetMinutes = 60,
): FloorDayStats[] {
  const cal = new Calendar(building.calendar);
  const ahStart = parseClock(building.afterHoursStart);
  const peakFrom = ahStart + peakOffsetMinutes;
  const ahEarly = parseClock(building.workdayStart);
  const map = new Map<string, FloorDayStats>();
  for (const iv of intervals) {
    const local = localParts(iv.start, building.timezone);
    const key = `${iv.floorId}|${local.dateKey}`;
    let s = map.get(key);
    if (!s) {
      s = {
        floorId: iv.floorId,
        dateKey: local.dateKey,
        dayType: cal.dayType(local.dateKey),
        afterHoursPeak: 0,
        afterHoursHvacHours: 0,
        afterHoursKwh: 0,
        totalKwh: 0,
      };
      map.set(key, s);
    }
    const kwh = totalKwh(iv);
    s.totalKwh += kwh;
    const afterHours = s.dayType !== "workday" || local.minuteOfDay >= ahStart || local.minuteOfDay < ahEarly;
    if (afterHours) {
      s.afterHoursKwh += kwh;
      s.afterHoursHvacHours += (iv.hvacOn * iv.minutes) / 60;
      if (s.dayType !== "workday" || local.minuteOfDay >= peakFrom)
        s.afterHoursPeak = Math.max(s.afterHoursPeak, iv.occupancy);
    }
  }
  return [...map.values()].sort(
    (a, b) => a.dateKey.localeCompare(b.dateKey) || a.floorId.localeCompare(b.floorId),
  );
}

export type ScheduleAdvice = "on_demand" | "setback" | "off";

export const SCHEDULE_LABELS: Record<ScheduleAdvice, string> = {
  on_demand: "Cool on demand (occupancy-gated)",
  setback: "Zone setback 26 °C",
  off: "Off after hours",
};

export interface ForecastParams {
  /** how many past same-weekdays to use */
  weeks: number;
  onDemandMinPeople: { workday: number; nonWorking: number };
  setbackMinPeople: number;
}

export const DEFAULT_FORECAST_PARAMS: ForecastParams = {
  weeks: 4,
  onDemandMinPeople: { workday: 5, nonWorking: 3 },
  setbackMinPeople: 1,
};

export interface FloorForecast {
  floorId: string;
  dateKey: string;
  dayType: DayType;
  median: number;
  low: number;
  high: number;
  /** number of past days the forecast is based on; 0 = no history */
  basis: number;
  advice: ScheduleAdvice;
  method: string;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

/**
 * Same-weekday median over the last N weeks, holidays excluded, range = min–max.
 * Deliberately simple and explainable; the schedule advice follows fixed, documented thresholds.
 */
export function forecastFloors(
  building: BuildingProfile,
  floors: readonly FloorProfile[],
  history: readonly FloorDayStats[],
  fromDateKey: string,
  days: number,
  params: Partial<ForecastParams> = {},
): FloorForecast[] {
  const p: ForecastParams = { ...DEFAULT_FORECAST_PARAMS, ...params };
  const cal = new Calendar(building.calendar);
  const byFloor = new Map<string, FloorDayStats[]>();
  for (const s of history) {
    const l = byFloor.get(s.floorId);
    if (l) l.push(s);
    else byFloor.set(s.floorId, [s]);
  }
  const out: FloorForecast[] = [];
  for (let d = 0; d < days; d++) {
    const dateKey = addDays(fromDateKey, d);
    const weekday = isoWeekdayOf(dateKey);
    const dayType = cal.dayType(dateKey);
    for (const floor of floors) {
      const past = (byFloor.get(floor.id) ?? [])
        .filter((s) => s.dateKey < dateKey && s.dayType !== "holiday" && isoWeekdayOf(s.dateKey) === weekday)
        .sort((a, b) => b.dateKey.localeCompare(a.dateKey))
        .slice(0, p.weeks)
        .map((s) => s.afterHoursPeak);
      const holiday = dayType === "holiday";
      const med = holiday ? 0 : Math.floor(median(past));
      const low = holiday || past.length === 0 ? 0 : Math.min(...past);
      const high = holiday || past.length === 0 ? 0 : Math.max(...past);
      const onDemand = dayType === "workday" ? p.onDemandMinPeople.workday : p.onDemandMinPeople.nonWorking;
      const advice: ScheduleAdvice =
        med >= onDemand
          ? "on_demand"
          : med >= p.setbackMinPeople && dayType === "workday"
            ? "setback"
            : "off";
      out.push({
        floorId: floor.id,
        dateKey,
        dayType,
        median: med,
        low,
        high,
        basis: holiday ? 0 : past.length,
        advice,
        method: holiday
          ? "holiday: no forecast, building closed"
          : `median of last ${past.length} same weekdays (holidays excluded)`,
      });
    }
  }
  return out;
}

/** Expected after-hours energy of a schedule advice, for planning views. */
export function plannedAfterHoursKwh(
  floor: FloorProfile,
  advice: ScheduleAdvice,
  dayType: DayType,
  hours = 2.5,
): number {
  const zone = floor.zoneOnlyFraction ?? 0.3;
  switch (advice) {
    case "on_demand":
      return round((floor.ratedHvacKw + floor.ratedLightingKw) * hours, 1);
    case "setback":
      return round(floor.ratedHvacKw * zone * hours + floor.ratedLightingKw * 0.3 * hours, 1);
    case "off":
      return dayType === "workday" ? round(floor.ratedHvacKw * 0.5 * 0.5, 1) : 0;
  }
}
