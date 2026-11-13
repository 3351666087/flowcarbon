import { describe, expect, it } from "vitest";
import {
  buildingFigures,
  COMPARE_MIN_COVERAGE,
  compareOrder,
  minCoveredDays,
  type WindowFigures,
  windowChange,
} from "../src";

const w = (days: number, kwh: number, afterHoursKwh: number, avoidableKwh = 0): WindowFigures => ({
  days,
  kwh,
  afterHoursKwh,
  avoidableKwh,
});

describe("building figures", () => {
  it("divides energy by the floor area and by the days with data", () => {
    const f = buildingFigures(w(20, 40_000, 12_000, 4_000), 1_000);
    expect(f.kwhPerM2Day).toBe(2);
    expect(f.afterHoursShare).toBeCloseTo(0.3);
    expect(f.avoidableShare).toBeCloseTo(0.1);
    expect(f.afterHoursPerDay).toBe(600);
  });

  it("gives no figure without area or without data", () => {
    expect(buildingFigures(w(20, 40_000, 12_000), 0).kwhPerM2Day).toBeNull();
    const empty = buildingFigures(w(0, 0, 0), 1_000);
    expect(empty).toEqual({
      kwhPerM2Day: null,
      afterHoursShare: null,
      avoidableShare: null,
      afterHoursPerDay: null,
    });
  });
});

describe("window change", () => {
  it("needs half the days of each window to have data", () => {
    expect(COMPARE_MIN_COVERAGE).toBe(0.5);
    expect(minCoveredDays(28)).toBe(14);
    expect(minCoveredDays(7)).toBe(4);
    const full = w(28, 28_000, 8_400);
    const c = windowChange(w(13, 13_000, 3_000), full, 1_000, 28);
    expect(Object.values(c).every((v) => v === null)).toBe(true);
    expect(windowChange(full, w(10, 10_000, 3_000), 1_000, 28).afterHoursPerDayPct).toBeNull();
    expect(windowChange(w(14, 14_000, 3_000), full, 1_000, 28).afterHoursPerDayPct).not.toBeNull();
  });

  it("is null, not 0, when the previous value is 0", () => {
    const c = windowChange(w(28, 28_000, 2_800), w(28, 28_000, 0), 1_000, 28);
    expect(c.afterHoursPerDayPct).toBeNull();
    expect(c.kwhPerM2DayPct).toBe(0);
  });

  it("gives share changes in percentage points", () => {
    const c = windowChange(w(28, 10_000, 2_500, 1_000), w(28, 10_000, 3_000, 1_500), 1_000, 28);
    expect(c.afterHoursSharePp).toBe(-5);
    expect(c.avoidableSharePp).toBe(-5);
  });

  it("compares after-hours energy per day when the windows have different day counts", () => {
    // 20 days at 500 kWh/day after hours against 28 days at 1 000: a 50 % drop, not 64 %
    const c = windowChange(w(20, 40_000, 10_000), w(28, 56_000, 28_000), 2_000, 28);
    expect(c.afterHoursPerDayPct).toBe(-50);
    // 2 000 kWh/day either way on 2 000 m²
    expect(c.kwhPerM2DayPct).toBe(0);
  });

  it("has no intensity change without area", () => {
    const c = windowChange(w(28, 28_000, 2_800), w(28, 30_000, 3_000), 0, 28);
    expect(c.kwhPerM2DayPct).toBeNull();
    expect(c.afterHoursPerDayPct).toBeCloseTo(-6.7, 1);
  });
});

describe("compare order", () => {
  const rows = [
    { id: "a", v: 3 },
    { id: "b", v: null },
    { id: "c", v: -2 },
    { id: "d", v: 10 },
  ];
  it("puts rows without a value last in both directions", () => {
    expect(compareOrder(rows, (r) => r.v, "asc").map((r) => r.id)).toEqual(["c", "a", "d", "b"]);
    expect(compareOrder(rows, (r) => r.v, "desc").map((r) => r.id)).toEqual(["d", "a", "c", "b"]);
  });

  it("sorts names and leaves the input alone", () => {
    const named = [{ n: "Tower B" }, { n: "Tower A" }];
    expect(compareOrder(named, (r) => r.n).map((r) => r.n)).toEqual(["Tower A", "Tower B"]);
    expect(named[0]!.n).toBe("Tower B");
  });
});
