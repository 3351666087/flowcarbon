import { describe, expect, it } from "vitest";
import {
  estimateStrategies,
  type Finding,
  floorDayStats,
  forecastFloors,
  STRATEGIES,
  triageOvertime,
  validateOvertimeRequest,
} from "../src";
import { at, building, floor, series } from "./helpers";

describe("forecast", () => {
  it("uses the same-weekday median of the last weeks and skips holidays", () => {
    const f1 = floor("f1");
    // four Tuesdays with 4, 6, 8, 30 people at 19:30
    const tuesdays = ["2026-09-15", "2026-09-22", "2026-09-29", "2026-10-06"];
    const counts = [4, 6, 8, 30];
    const intervals = tuesdays.flatMap((d, i) => series("f1", d, "19:30", [{ occ: counts[i]!, hvac: 1 }]));
    const stats = floorDayStats(building, intervals);
    expect(stats.map((s) => s.afterHoursPeak)).toEqual(counts);
    const fc = forecastFloors(building, [f1], stats, "2026-10-13", 1);
    expect(fc[0]).toMatchObject({ median: 7, low: 4, high: 30, basis: 4, advice: "on_demand" });
    const holiday = forecastFloors(building, [f1], stats, "2026-10-01", 1);
    expect(holiday[0]).toMatchObject({ dayType: "holiday", median: 0, advice: "off" });
  });

  it("ignores people still leaving in the first hour after hours", () => {
    const iv = series("f1", "2026-10-13", "18:00", [
      { occ: 40 },
      { occ: 20 },
      { occ: 5 },
      { occ: 3 },
      { occ: 2 },
    ]);
    expect(floorDayStats(building, iv)[0]!.afterHoursPeak).toBe(2);
  });
});

describe("strategies", () => {
  const mk = (ruleId: Finding["ruleId"], dayType: Finding["dayType"], kwh: number): Finding => ({
    ruleId,
    kind: "waste",
    floorId: "f1",
    start: 0,
    end: 1,
    dayType,
    avoidableKwh: kwh,
    peakPeople: 0,
    tier: "measured",
    evidence: { summary: "", facts: {} },
  });
  it("annualises per day type and never double counts in the full package", () => {
    const findings = [
      mk("hvac_empty_floor", "workday", 100),
      mk("hvac_unrequested_non_working", "weekend", 50),
      mk("lights_on_empty_night", "workday", 10),
    ];
    const est = estimateStrategies(findings, [floor("f1"), floor("f2")], {
      observed: { workday: 10, weekend: 4, holiday: 0 },
      annual: { workday: 250, weekend: 104, holiday: 11 },
    });
    const by = Object.fromEntries(est.map((e) => [e.id, e]));
    expect(by.occupancy_gated_workday!.annualKwh).toBe(2500);
    expect(by.zone_only_non_working!.annualKwh).toBe(1300);
    expect(by.auto_lights_off!.annualKwh).toBe(250);
    expect(by.full_package!.annualKwh).toBe(4050);
    expect(by.full_package!.capex).toBe(2 * (6000 + 15000 + 1000) + 16000);
    expect(Object.keys(STRATEGIES)).toHaveLength(3);
  });
});

describe("overtime requests", () => {
  const tenant = { id: "t1", name: "Northwind", overtimeRatePerHour: 180 };
  const now = at("2026-10-13", "12:00");
  it("validates tenancy, duration and timing", () => {
    const ok = {
      tenantId: "t1",
      floorId: "f1",
      start: at("2026-10-15", "18:30"),
      hours: 2,
      expectedPeople: 2,
    };
    expect(validateOvertimeRequest(ok, { tenantFloors: ["f1"], now })).toEqual([]);
    expect(validateOvertimeRequest({ ...ok, floorId: "f9" }, { tenantFloors: ["f1"], now })).toHaveLength(1);
    expect(validateOvertimeRequest({ ...ok, hours: 1.1 }, { tenantFloors: ["f1"], now }).join()).toMatch(
      /15 minutes/,
    );
    expect(
      validateOvertimeRequest(
        { ...ok, start: at("2026-10-12", "18:00") },
        { tenantFloors: ["f1"], now },
      ).join(),
    ).toMatch(/over/);
  });
  it("recommends a setback below the people threshold and prices the request", () => {
    const t = triageOvertime(
      { tenantId: "t1", floorId: "f1", start: 0, hours: 2, expectedPeople: 2 },
      tenant,
      floor("f1"),
    );
    expect(t).toMatchObject({ mode: "setback", fee: 360 });
    expect(
      triageOvertime(
        { tenantId: "t1", floorId: "f1", start: 0, hours: 2.5, expectedPeople: 8 },
        tenant,
        floor("f1"),
      ).mode,
    ).toBe("full");
  });
});
