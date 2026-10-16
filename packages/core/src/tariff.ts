import { inWindow, localParts, parseClock } from "./time";

export interface FlatTariff {
  kind: "flat";
  /** price per kWh in the building currency */
  rate: number;
}

export interface TouPeriod {
  name: string;
  /** local "HH:MM", inclusive */
  start: string;
  /** local "HH:MM", exclusive; may wrap past midnight */
  end: string;
  rate: number;
}

/** Time-of-use tariff, as used for most commercial electricity in mainland China. */
export interface TouTariff {
  kind: "tou";
  periods: TouPeriod[];
  /** rate for any time not covered by a period */
  defaultRate: number;
}

export type Tariff = FlatTariff | TouTariff;

interface CompiledPeriod {
  start: number;
  end: number;
  rate: number;
}

const compiled = new WeakMap<TouTariff, CompiledPeriod[]>();

function compile(t: TouTariff): CompiledPeriod[] {
  let c = compiled.get(t);
  if (!c) {
    c = t.periods.map((p) => ({ start: parseClock(p.start), end: parseClock(p.end), rate: p.rate }));
    compiled.set(t, c);
  }
  return c;
}

export function priceAt(tariff: Tariff, ts: number, timeZone: string): number {
  if (tariff.kind === "flat") return tariff.rate;
  const minute = localParts(ts, timeZone).minuteOfDay;
  for (const p of compile(tariff)) if (inWindow(minute, p.start, p.end)) return p.rate;
  return tariff.defaultRate;
}

/** Average price, used for annualised figures when the hour of a saving is unknown. */
export function averageRate(tariff: Tariff): number {
  if (tariff.kind === "flat") return tariff.rate;
  let weighted = 0;
  let covered = 0;
  for (const p of compile(tariff)) {
    const len = p.start <= p.end ? p.end - p.start : 1440 - p.start + p.end;
    weighted += len * p.rate;
    covered += len;
  }
  return (weighted + Math.max(0, 1440 - covered) * tariff.defaultRate) / 1440;
}

export function validateTariff(t: Tariff): string[] {
  const errors: string[] = [];
  if (t.kind === "flat") {
    if (!(t.rate >= 0)) errors.push("rate must be ≥ 0");
    return errors;
  }
  if (!(t.defaultRate >= 0)) errors.push("defaultRate must be ≥ 0");
  const minutes = new Array<number>(1440).fill(0);
  for (const p of t.periods) {
    let s: number;
    let e: number;
    try {
      s = parseClock(p.start);
      e = parseClock(p.end);
    } catch (err) {
      errors.push(`${p.name}: ${(err as Error).message}`);
      continue;
    }
    if (!(p.rate >= 0)) errors.push(`${p.name}: rate must be ≥ 0`);
    for (let m = 0; m < 1440; m++) if (inWindow(m, s, e)) minutes[m]! += 1;
  }
  if (minutes.some((c) => c > 1)) errors.push("tariff periods overlap");
  return errors;
}
