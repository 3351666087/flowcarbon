import {
  buildFloorIntervals,
  covers,
  detectFindings,
  type Finding,
  measureCovers,
  occupancyFromDoorCounts,
} from "@flowcarbon/core";
import { describe, expect, it } from "vitest";
import { approvedWindows, type SimControl, sampleTower, simulate } from "../src";

const sb = sampleTower();
const window = { startDate: "2026-09-15", days: 28 };

function findingsOf(controls: SimControl[] = []) {
  const sim = simulate(sb, { ...window, controls });
  const occ = occupancyFromDoorCounts(sim.doorCounts, { timeZone: sb.building.timezone });
  const intervals = buildFloorIntervals({
    floors: sb.floors,
    from: sim.from,
    to: sim.to,
    readings: sim.readings,
    hvacEvents: sim.hvacEvents,
    lightingEvents: sim.lightingEvents,
    occupancy: [...occ].flatMap(([floorId, pts]) =>
      pts.map((p) => ({ floorId, ts: p.start, count: p.count })),
    ),
  });
  return {
    sim,
    findings: detectFindings({
      building: sb.building,
      floors: sb.floors,
      intervals,
      approvedOvertime: approvedWindows(sim.overtime),
    }),
  };
}

const kwh = (list: Finding[]) => list.reduce((s, f) => s + f.avoidableKwh, 0);

describe("strategies put into effect in the simulated tower", () => {
  const before = findingsOf();
  const strategies = ["occupancy_gated_workday", "zone_only_non_working", "auto_lights_off"] as const;

  for (const strategy of strategies) {
    it(`${strategy} removes the waste it covers on its floor and nowhere else`, () => {
      const scope = (f: Finding) => covers(measureCovers(strategy, "hvac_empty_floor"), f);
      // the floor with the most covered waste before
      const byFloor = new Map<string, number>();
      for (const f of before.findings.filter(scope))
        byFloor.set(f.floorId, (byFloor.get(f.floorId) ?? 0) + f.avoidableKwh);
      const [floorId, wasted] = [...byFloor].sort((a, b) => b[1] - a[1])[0]!;
      expect(wasted).toBeGreaterThan(20);

      const after = findingsOf([{ floorId, strategy, from: before.sim.from }]);
      const mine = (list: Finding[]) => list.filter((f) => f.floorId === floorId && scope(f));
      expect(kwh(mine(after.findings))).toBeLessThan(wasted * 0.05);
      const others = (list: Finding[]) => list.filter((f) => f.floorId !== floorId);
      expect(kwh(others(after.findings))).toBeCloseTo(kwh(others(before.findings)), 6);
      // the same people came and went
      expect(after.sim.doorCounts).toEqual(before.sim.doorCounts);
    });
  }

  it("changes nothing before the strategy starts", () => {
    const from = before.sim.from + 14 * 86_400_000;
    const after = findingsOf(strategies.map((strategy) => ({ floorId: sb.floors[5]!.id, strategy, from })));
    const early = (list: Finding[]) => list.filter((f) => f.start < from);
    expect(early(after.findings)).toEqual(early(before.findings));
    const late = (list: Finding[]) => list.filter((f) => f.start >= from && f.floorId === sb.floors[5]!.id);
    expect(kwh(late(after.findings))).toBeLessThan(kwh(late(before.findings)));
  });
});
