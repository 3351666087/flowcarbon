import { describe, expect, it } from "vitest";
import {
  averageRate,
  type EmissionFactor,
  evaluateEpc,
  priceAt,
  scope2,
  selectFactor,
  type TouTariff,
  validateTariff,
} from "../src";
import { at, TZ } from "./helpers";

const tou: TouTariff = {
  kind: "tou",
  defaultRate: 0.6,
  periods: [
    { name: "peak", start: "08:00", end: "11:00", rate: 1.2 },
    { name: "valley", start: "23:00", end: "07:00", rate: 0.3 },
  ],
};

describe("tariff", () => {
  it("prices by local time of use, including a period across midnight", () => {
    expect(priceAt(tou, at("2026-10-13", "09:30"), TZ)).toBe(1.2);
    expect(priceAt(tou, at("2026-10-13", "02:00"), TZ)).toBe(0.3);
    expect(priceAt(tou, at("2026-10-13", "15:00"), TZ)).toBe(0.6);
    expect(averageRate({ kind: "flat", rate: 0.85 })).toBe(0.85);
    expect(averageRate(tou)).toBeCloseTo((3 * 60 * 1.2 + 8 * 60 * 0.3 + 13 * 60 * 0.6) / 1440, 6);
  });

  it("rejects overlapping periods", () => {
    expect(validateTariff(tou)).toEqual([]);
    expect(
      validateTariff({
        ...tou,
        periods: [...tou.periods, { name: "x", start: "10:00", end: "12:00", rate: 1 }],
      }),
    ).toContain("tariff periods overlap");
  });
});

const f = (over: Partial<EmissionFactor>): EmissionFactor => ({
  id: "x",
  region: "CN",
  year: 2022,
  method: "location",
  kgPerKwh: 0.5,
  source: "test",
  status: "to_verify",
  ...over,
});

describe("carbon", () => {
  const lib = [
    f({ id: "cn22", year: 2022, kgPerKwh: 0.5703 }),
    f({ id: "cn23", year: 2023, kgPerKwh: 0.5366 }),
    f({ id: "east22", region: "CN-East", year: 2022, kgPerKwh: 0.5 }),
    f({ id: "future", region: "CN-East", year: 2030, kgPerKwh: 0.1 }),
  ];
  it("prefers the most specific region, then the latest year not after the reporting year", () => {
    expect(selectFactor(lib, { region: "CN-East", year: 2026, method: "location" })?.id).toBe("east22");
    expect(selectFactor(lib, { region: "CN-North", year: 2026, method: "location" })?.id).toBe("cn23");
    expect(selectFactor(lib, { region: "CN-North", year: 2022, method: "location" })?.id).toBe("cn22");
    expect(selectFactor(lib, { region: "US", year: 2026, method: "location" })).toBeUndefined();
  });

  it("computes location- and market-based Scope 2", () => {
    const loc = f({ kgPerKwh: 0.5 });
    const r = scope2(1000, loc, [
      { kind: "green_certificate", kwh: 300, kgPerKwh: 0 },
      { kind: "ppa", kwh: 2000, kgPerKwh: 0 },
    ]);
    expect(r.locationBasedKg).toBe(500);
    expect(r.marketBasedKg).toBe(0); // instruments capped at consumption
    expect(r.greenShare).toBe(1);
    const r2 = scope2(
      1000,
      loc,
      [{ kind: "green_certificate", kwh: 300, kgPerKwh: 0 }],
      f({ kgPerKwh: 0.6 }),
    );
    expect(r2.marketBasedKg).toBeCloseTo(420);
    expect(r2.greenShare).toBeCloseTo(0.3);
  });
});

describe("energy performance contract", () => {
  it("splits verified savings and computes paybacks", () => {
    const r = evaluateEpc({
      annualKwh: 100_000,
      tariff: 1,
      achieved: 0.9,
      capex: 120_000,
      escoShare: 0.6,
      years: 5,
      discountRate: 0,
    });
    expect(r.annualSaving).toBe(90_000);
    expect(r.ownerAnnual).toBe(36_000);
    expect(r.escoAnnual).toBe(54_000);
    expect(r.escoPaybackYears).toBeCloseTo(120_000 / 54_000);
    expect(r.selfFundedPaybackYears).toBeCloseTo(120_000 / 90_000);
    expect(r.timeline.at(-1)?.escoCumulative).toBe(54_000 * 5 - 120_000);
    expect(r.escoNpv).toBe(54_000 * 5 - 120_000);
  });
  it("never pays back with zero savings", () => {
    expect(
      evaluateEpc({ annualKwh: 0, tariff: 1, achieved: 1, capex: 1, escoShare: 0.5, years: 3 })
        .escoPaybackYears,
    ).toBe(Infinity);
    expect(() =>
      evaluateEpc({ annualKwh: 1, tariff: 1, achieved: 1, capex: 1, escoShare: 1.5, years: 3 }),
    ).toThrow();
  });
});
