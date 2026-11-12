/** cookie holding the reader's language, read by the server for the first paint */
export const LOCALE_COOKIE = "fc_locale";

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
    // whole units from 100 up (CN¥1,200, CN¥900); cents only where they matter, as in a tariff
    maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2,
  }).format(v);
}

/** kg → t with one decimal above a tonne */
export const co2 = (kg: number | null | undefined, locale: Locale) =>
  Math.abs(kg ?? 0) >= 1000 ? `${num((kg ?? 0) / 1000, locale, 1)} tCO₂e` : `${num(kg, locale)} kgCO₂e`;

export const pct = (share: number | null | undefined, locale: Locale, digits = 0) =>
  share === null || share === undefined ? "–" : `${num(share * 100, locale, digits)} %`;

/**
 * A figure in a number in running text: grouped digits, or digits with an optional decimal part. It must not sit inside
 * a word, a date, a time or a version (F10, 2026-11-01, 18:30, 0.2.1), so neither side may touch letters, digits,
 * separators or a further decimal part.
 */
const FIGURE =
  /(?<![\w.:/-])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:(\s?kWh\b)|(\s?(?:CNY|RMB)\b|\s?元)|(\s?%)|)(?![\w:/-]|[.,]\d)/g;

/**
 * Text written by a model or a template, with its figures shown the way the cards beside it show them: "181288 kWh"
 * as 181.3 MWh, "163000 CNY" as money, "6.9%" as 6.9 %, and other whole numbers of four digits or more grouped. For
 * display only: what was stored and checked stays as it was. Years (1900–2099) are left alone.
 */
export function prettyNumbers(text: string, locale: Locale, currency = "CNY"): string {
  if (!text) return text;
  return text.replace(FIGURE, (all, figure: string, energy?: string, cash?: string, share?: string) => {
    const v = Number(figure.replace(/,/g, ""));
    if (!Number.isFinite(v)) return all;
    // below a thousand there is nothing to group, and kwh() would drop the decimals the text gave
    if (energy) return Math.abs(v) < 1000 ? all : kwh(v, locale);
    if (cash) return money(v, locale, currency);
    if (share) {
      const decimals = figure.split(".")[1]?.length ?? 0;
      return pct(v / 100, locale, Math.min(decimals, 1));
    }
    if (figure.includes(",") || figure.includes(".") || figure.length < 4) return all;
    if (figure.length === 4 && v >= 1900 && v < 2100) return all;
    return num(v, locale);
  });
}

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
