/**
 * Buildings side by side: figures that can be compared between buildings of different size and
 * between two windows that are not equally covered by data.
 *
 * Every figure is per day with data, so a window with gaps is not read as a drop, and per m² of the
 * floor area entered for the building's floors. A change is null ("not enough data to compare"),
 * never 0, when either window has too few days with data or there is nothing to compare against.
 */

/** a window must have data on at least this share of its days before its change is shown */
export const COMPARE_MIN_COVERAGE = 0.5;

/** Totals of one building over one window, from its daily roll-ups. */
export interface WindowFigures {
  /** days in the window that have data */
  days: number;
  kwh: number;
  afterHoursKwh: number;
  avoidableKwh: number;
}

export interface BuildingFigures {
  /** kWh per m² of entered floor area per day with data; null without area or data */
  kwhPerM2Day: number | null;
  /** share of the energy used after hours; null without energy */
  afterHoursShare: number | null;
  /** share of the energy the rules flag as avoidable; null without energy */
  avoidableShare: number | null;
  /** after-hours kWh per day with data; null without data */
  afterHoursPerDay: number | null;
}

export interface WindowChange {
  /** % change of kWh per m² per day */
  kwhPerM2DayPct: number | null;
  /** % change of after-hours kWh per day: negative means after-hours use dropped */
  afterHoursPerDayPct: number | null;
  /** change of the after-hours share, in percentage points */
  afterHoursSharePp: number | null;
  /** change of the avoidable share, in percentage points */
  avoidableSharePp: number | null;
}

const r = (x: number, digits: number) => {
  const p = 10 ** digits;
  return Math.round(x * p) / p;
};

export function buildingFigures(w: WindowFigures, areaM2: number): BuildingFigures {
  return {
    kwhPerM2Day: w.days > 0 && areaM2 > 0 ? r(w.kwh / areaM2 / w.days, 4) : null,
    afterHoursShare: w.kwh > 0 ? w.afterHoursKwh / w.kwh : null,
    avoidableShare: w.kwh > 0 ? w.avoidableKwh / w.kwh : null,
    afterHoursPerDay: w.days > 0 ? r(w.afterHoursKwh / w.days, 1) : null,
  };
}

/** Days with data a window needs before its change is shown. */
export function minCoveredDays(windowDays: number): number {
  return Math.ceil(windowDays * COMPARE_MIN_COVERAGE);
}

/** Change from the previous window to the current one, per day with data. */
export function windowChange(
  current: WindowFigures,
  previous: WindowFigures,
  areaM2: number,
  windowDays: number,
): WindowChange {
  const none: WindowChange = {
    kwhPerM2DayPct: null,
    afterHoursPerDayPct: null,
    afterHoursSharePp: null,
    avoidableSharePp: null,
  };
  const need = minCoveredDays(windowDays);
  if (current.days < need || previous.days < need) return none;
  const cur = buildingFigures(current, areaM2);
  const prev = buildingFigures(previous, areaM2);
  // unrounded per-day values, so the percentage does not carry the display rounding
  const perM2 = (w: WindowFigures) => (areaM2 > 0 ? w.kwh / areaM2 / w.days : null);
  const pct = (c: number | null, p: number | null) =>
    c === null || p === null || p === 0 ? null : r(((c - p) / p) * 100, 1);
  const pp = (c: number | null, p: number | null) => (c === null || p === null ? null : r((c - p) * 100, 1));
  return {
    kwhPerM2DayPct: pct(perM2(current), perM2(previous)),
    afterHoursPerDayPct: pct(current.afterHoursKwh / current.days, previous.afterHoursKwh / previous.days),
    afterHoursSharePp: pp(cur.afterHoursShare, prev.afterHoursShare),
    avoidableSharePp: pp(cur.avoidableShare, prev.avoidableShare),
  };
}

/** Sorts by a numeric (or string) key; rows without a value always come last, in either direction. */
export function compareOrder<T>(
  rows: readonly T[],
  key: (row: T) => number | string | null | undefined,
  dir: "asc" | "desc" = "asc",
): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const xn = x === null || x === undefined || (typeof x === "number" && Number.isNaN(x));
    const yn = y === null || y === undefined || (typeof y === "number" && Number.isNaN(y));
    if (xn || yn) return xn === yn ? 0 : xn ? 1 : -1;
    if (typeof x === "string" || typeof y === "string") return sign * String(x).localeCompare(String(y));
    return sign * ((x as number) - (y as number));
  });
}
