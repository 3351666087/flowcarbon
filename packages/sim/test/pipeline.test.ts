import {
  buildFloorIntervals,
  buildReport,
  detectFindings,
  type EmissionFactor,
  estimateStrategies,
  evaluateEpc,
  occupancyFromDoorCounts,
} from "@flowcarbon/core";
import { describe, expect, it } from "vitest";
import { approvedWindows, sampleTower, simulate } from "../src";

describe("simulated tower, end to end", () => {
  const sb = sampleTower();
  const sim = simulate(sb, { startDate: "2026-09-15", days: 28 });
  const occ = occupancyFromDoorCounts(sim.doorCounts, { timeZone: sb.building.timezone });
  const occupancy = [...occ].flatMap(([floorId, pts]) =>
    pts.map((p) => ({ floorId, ts: p.start, count: p.count })),
  );
  const intervals = buildFloorIntervals({
    floors: sb.floors,
    from: sim.from,
    to: sim.to,
    readings: sim.readings,
    hvacEvents: sim.hvacEvents,
    lightingEvents: sim.lightingEvents,
    occupancy,
  });
  const findings = detectFindings({
    building: sb.building,
    floors: sb.floors,
    intervals,
    approvedOvertime: approvedWindows(sim.overtime),
  });
  const factor: EmissionFactor = {
    id: "cn",
    region: "CN",
    year: 2023,
    method: "location",
    kgPerKwh: 0.5703,
    source: "test",
    status: "to_verify",
  };
  const report = buildReport({
    building: sb.building,
    floors: sb.floors,
    intervals,
    findings,
    locationFactor: factor,
    from: sim.from,
    to: sim.to,
  });

  it("is deterministic", () => {
    const again = simulate(sb, { startDate: "2026-09-15", days: 28 });
    expect(again.doorCounts.length).toBe(sim.doorCounts.length);
    expect(again.overtime).toEqual(sim.overtime);
  });

  it("produces plausible totals for a 12-floor tower over 28 days", () => {
    expect(intervals).toHaveLength(12 * 28 * 96);
    expect(report.period.dayTypes).toEqual({ workday: 15, weekend: 6, holiday: 7 });
    expect(report.totals.kwh).toBeGreaterThan(150_000);
    expect(report.totals.kwh).toBeLessThan(250_000);
    expect(report.totals.avoidableShare).toBeGreaterThan(0.08);
    expect(report.totals.avoidableShare).toBeLessThan(0.2);
    expect(report.totals.measuredShare).toBeGreaterThan(0.4);
    expect(report.byRule.map((r) => r.ruleId).sort()).toEqual([
      "full_floor_few_people",
      "hvac_empty_floor",
      "hvac_unrequested_non_working",
      "lights_on_empty_night",
    ]);
  });

  it("supports an energy performance contract with a payback inside a 5-year term", () => {
    const est = estimateStrategies(findings, sb.floors, {
      observed: report.period.dayTypes,
      annual: { workday: 250, weekend: 104, holiday: 11 },
    });
    const full = est.find((e) => e.id === "full_package")!;
    const epc = evaluateEpc({
      annualKwh: full.annualKwh,
      tariff: 0.85,
      achieved: 1,
      capex: full.capex,
      escoShare: 0.6,
      years: 5,
    });
    expect(epc.escoPaybackYears).toBeLessThan(5);
    expect(epc.selfFundedPaybackYears).toBeLessThan(epc.escoPaybackYears);
  });

  it("writes evidence a person can check", () => {
    for (const f of findings.slice(0, 20)) {
      expect(f.evidence.summary).toMatch(/kWh/);
      expect(f.evidence.facts.floor).toBeTruthy();
    }
  });
});
