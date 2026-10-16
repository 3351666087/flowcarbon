/** Time helpers. Timestamps are epoch milliseconds (UTC); local wall-clock values are derived per building time zone. */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** ISO weekday: 1 = Monday … 7 = Sunday */
  isoWeekday: number;
  /** YYYY-MM-DD in the building's local time */
  dateKey: string;
  /** minutes since local midnight */
  minuteOfDay: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function localParts(ts: number, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ts))) parts[p.type] = p.value;
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const isoWeekday = WEEKDAYS[parts.weekday ?? ""] ?? 1;
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  return { year, month, day, hour, minute, isoWeekday, dateKey, minuteOfDay: hour * 60 + minute };
}

/** Offset of the zone from UTC at a given instant, in minutes (e.g. +480 for Asia/Shanghai). */
export function zoneOffsetMinutes(ts: number, timeZone: string): number {
  const p = localParts(ts, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(ts / MINUTE) * MINUTE) / MINUTE);
}

/** Epoch ms of a local wall-clock time (dateKey + minutes after midnight) in a zone. */
export function zonedTime(dateKey: string, minuteOfDay: number, timeZone: string): number {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, 0, minuteOfDay);
  const first = guess - zoneOffsetMinutes(guess, timeZone) * MINUTE;
  // second pass corrects for an offset change between the guess and the result (DST edges)
  return guess - zoneOffsetMinutes(first, timeZone) * MINUTE;
}

export function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** ISO weekday (1 = Monday) of a calendar date, independent of time zone. */
export function isoWeekdayOf(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

/** "HH:MM" → minutes after midnight. */
export function parseClock(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Invalid clock time "${hhmm}", expected HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) throw new Error(`Invalid clock time "${hhmm}"`);
  return h * 60 + min;
}

export function formatClock(minuteOfDay: number): string {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** True if minuteOfDay falls in [start, end), where the window may wrap past midnight. */
export function inWindow(minuteOfDay: number, start: number, end: number): boolean {
  return start <= end ? minuteOfDay >= start && minuteOfDay < end : minuteOfDay >= start || minuteOfDay < end;
}
