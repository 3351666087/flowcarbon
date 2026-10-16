export type Locale = "en" | "zh";

const intl = (locale: Locale) => (locale === "zh" ? "zh-CN" : "en-GB");

export function num(v: number | null | undefined, locale: Locale, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  return new Intl.NumberFormat(intl(locale), {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(v);
}

export const kwh = (v: number | null | undefined, locale: Locale) =>
  Math.abs(v ?? 0) >= 100_000 ? `${num((v ?? 0) / 1000, locale, 1)} MWh` : `${num(v, locale)} kWh`;

export function money(v: number | null | undefined, locale: Locale, currency = "CNY"): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  return new Intl.NumberFormat(intl(locale), {
    style: "currency",
    currency,
    maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2,
  }).format(v);
}

/** kg → t with one decimal above a tonne */
export const co2 = (kg: number | null | undefined, locale: Locale) =>
  Math.abs(kg ?? 0) >= 1000 ? `${num((kg ?? 0) / 1000, locale, 1)} tCO₂e` : `${num(kg, locale)} kgCO₂e`;

export const pct = (share: number | null | undefined, locale: Locale, digits = 0) =>
  share === null || share === undefined ? "–" : `${num(share * 100, locale, digits)} %`;

export function dateTime(
  iso: string | null | undefined,
  locale: Locale,
  timeZone: string,
  opts: Intl.DateTimeFormatOptions = {},
) {
  if (!iso) return "–";
  return new Intl.DateTimeFormat(intl(locale), {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
    ...opts,
  }).format(new Date(iso));
}

export function time(iso: string, locale: Locale, timeZone: string) {
  return new Intl.DateTimeFormat(intl(locale), {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** A local date key (YYYY-MM-DD) shown as a short date. */
export function day(
  dateKey: string,
  locale: Locale,
  opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", weekday: "short" },
) {
  return new Intl.DateTimeFormat(intl(locale), { timeZone: "UTC", ...opts }).format(
    new Date(`${dateKey}T00:00:00Z`),
  );
}

export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Local wall time in a zone → ISO instant (for datetime-local inputs). */
export function zonedToIso(local: string, timeZone: string): string {
  const [date, clock] = local.split("T") as [string, string];
  const guess = Date.parse(`${date}T${clock}:00Z`);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const p of formatter.formatToParts(new Date(guess))) parts[p.type] = p.value;
  const asLocal = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
  return new Date(guess - (asLocal - guess)).toISOString();
}
