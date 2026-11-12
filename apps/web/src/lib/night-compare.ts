import { addDays } from "./format";

/** a floor this much above the same day a week earlier is marked */
export const NIGHT_HIGH_SHARE = 0.2;
/** …and by at least this many kWh, so a floor going from 0.4 to 0.6 kWh is not called out */
const NIGHT_HIGH_MIN_KWH = 1;

export interface NightRow {
  floorId: string;
  day: string;
  kwhAfterHours: number;
}

export interface FloorNight {
  floorId: string;
  latest: number;
  /** null when the floor has no figure for the day a week earlier */
  prior: number | null;
  delta: number | null;
  /** change against the week before as a share of it; null when there is nothing to compare against */
  share: number | null;
  high: boolean;
}

/**
 * Each floor's after-hours energy on the latest whole day with data against the same weekday a week before. The
 * day still coming in (today in the building) is left out, as the overview's own figures leave it out. Floors with
 * the biggest increase come first.
 */
export function compareNights(
  rows: readonly NightRow[],
  asOf: string | null | undefined,
  today: string,
): { latest: string; prior: string; floors: FloorNight[] } | null {
  if (!asOf || rows.length === 0) return null;
  const whole = asOf >= today ? addDays(today, -1) : asOf;
  const days = [...new Set(rows.map((r) => r.day))].filter((d) => d <= whole).sort();
  const latest = days.at(-1);
  if (!latest) return null;
  const prior = addDays(latest, -7);
  const byFloor = new Map<string, { latest: number | null; prior: number | null }>();
  for (const r of rows) {
    if (r.day !== latest && r.day !== prior) continue;
    const f = byFloor.get(r.floorId) ?? { latest: null, prior: null };
    if (r.day === latest) f.latest = (f.latest ?? 0) + r.kwhAfterHours;
    else f.prior = (f.prior ?? 0) + r.kwhAfterHours;
    byFloor.set(r.floorId, f);
  }
  const floors: FloorNight[] = [];
  for (const [floorId, f] of byFloor) {
    if (f.latest === null) continue;
    const delta = f.prior === null ? null : f.latest - f.prior;
    const share = delta === null || !f.prior ? null : delta / f.prior;
    const high =
      delta !== null &&
      delta >= NIGHT_HIGH_MIN_KWH &&
      // from nothing to something counts as well above
      (share === null ? f.prior === 0 : share >= NIGHT_HIGH_SHARE);
    floors.push({ floorId, latest: f.latest, prior: f.prior, delta, share, high });
  }
  floors.sort((a, b) => (b.delta ?? Number.NEGATIVE_INFINITY) - (a.delta ?? Number.NEGATIVE_INFINITY));
  return { latest, prior, floors };
}
