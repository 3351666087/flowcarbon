export type FactorMethod = "location" | "market";
export type FactorStatus = "verified" | "to_verify";

/** One entry of the emission-factor library. Provenance is mandatory. */
export interface EmissionFactor {
  id: string;
  /** hierarchical code, most general first: "CN" (national), "CN-East" (regional grid), "CN-East-JS" (province) */
  region: string;
  year: number;
  method: FactorMethod;
  /** kg CO2e per kWh */
  kgPerKwh: number;
  source: string;
  status: FactorStatus;
}

/** Contractual instruments for market-based Scope 2 (GHG Protocol Scope 2 Guidance). */
export interface ContractualInstrument {
  kind: "green_certificate" | "ppa" | "green_tariff" | "onsite_renewable";
  kwh: number;
  /** emission rate of the contracted electricity; 0 for renewables */
  kgPerKwh: number;
  description?: string;
}

export function selectFactor(
  factors: readonly EmissionFactor[],
  opts: { region: string; year: number; method: FactorMethod },
): EmissionFactor | undefined {
  const candidates = factors.filter((f) => f.method === opts.method && f.year <= opts.year);
  // most specific region first ("CN-East-JS" > "CN-East" > "CN" > "GLOBAL"), then the most recent year
  const specificity = (r: string) =>
    opts.region === r ? 1_000 : opts.region.startsWith(`${r}-`) ? 1 + r.length : r === "GLOBAL" ? 1 : 0;
  return candidates
    .filter((f) => specificity(f.region) > 0)
    .sort((a, b) => specificity(b.region) - specificity(a.region) || b.year - a.year)[0];
}

export interface Scope2Result {
  kwh: number;
  locationBasedKg: number;
  marketBasedKg: number;
  /** share of consumption covered by zero-emission contractual instruments */
  greenShare: number;
  locationFactor: EmissionFactor;
  residualFactor: EmissionFactor | undefined;
}

/**
 * Scope 2 by both methods. Market-based: instruments first (capped at consumption), the remainder at the
 * residual-mix factor if one exists, otherwise at the location factor (and this is disclosed).
 */
export function scope2(
  kwh: number,
  locationFactor: EmissionFactor,
  instruments: readonly ContractualInstrument[] = [],
  residualFactor?: EmissionFactor,
): Scope2Result {
  let remaining = kwh;
  let marketKg = 0;
  let green = 0;
  for (const ins of instruments) {
    const used = Math.min(remaining, Math.max(0, ins.kwh));
    marketKg += used * ins.kgPerKwh;
    if (ins.kgPerKwh === 0) green += used;
    remaining -= used;
  }
  marketKg += remaining * (residualFactor ?? locationFactor).kgPerKwh;
  return {
    kwh,
    locationBasedKg: kwh * locationFactor.kgPerKwh,
    marketBasedKg: marketKg,
    greenShare: kwh > 0 ? green / kwh : 0,
    locationFactor,
    residualFactor,
  };
}
