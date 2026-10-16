import { describe, expect, it } from "vitest";
import { DEFAULT_RULE_PARAMS, detectFindings, RULE_PARAM_RATIONALE } from "../src";
import { at, building, floor, series } from "./helpers";

const f1 = floor("f1");
const f2 = floor("f2");
const run = (
  intervals: ReturnType<typeof series>,
  extra: Parameters<typeof detectFindings>[0] extends infer T ? Partial<T> : never = {},
) => detectFindings({ building, floors: [f1, f2], intervals, ...extra });

describe("rule: cooling an empty floor", () => {
  it("counts HVAC energy only after the 30-minute grace period", () => {
    // Tue 2026-10-13, 19:00: people leave, AC keeps running for 1.5 h
    const iv = series("f1", "2026-10-13", "19:00", [
      { occ: 4, hvac: 1 },
      { occ: 0, hvac: 1 },
      { occ: 0, hvac: 1 },
      { occ: 0, hvac: 1 },
      { occ: 0, hvac: 1 },
      { occ: 0, hvac: 1 },
      { occ: 0, hvac: 0 },
    ]);
    const fs = run(iv);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.ruleId).toBe("hvac_empty_floor");
    expect(fs[0]!.start).toBe(at("2026-10-13", "19:45"));
    expect(fs[0]!.end).toBe(at("2026-10-13", "20:30"));
    expect(fs[0]!.avoidableKwh).toBe(30); // 3 intervals × 10 kWh after grace
    expect(fs[0]!.evidence.facts.graceMinutes).toBe(30);
  });

  it("does not flag morning pre-cooling", () => {
    const iv = series(
      "f1",
      "2026-10-13",
      "07:00",
      Array.from({ length: 8 }, () => ({ occ: 0, hvac: 1 })),
    );
    expect(run(iv).filter((f) => f.start < at("2026-10-13", "09:00"))).toEqual([]);
  });

  it("resets when someone returns", () => {
    const iv = series("f1", "2026-10-13", "19:00", [
      { occ: 0, hvac: 1 },
      { occ: 0, hvac: 1 },
      { occ: 1, hvac: 1, mode: "setback" },
      { occ: 0, hvac: 1 },
      { occ: 0, hvac: 1 },
    ]);
    expect(run(iv)).toEqual([]);
  });
});

describe("rule: cooled on a non-working day without a request", () => {
  it("takes precedence and needs another floor's approved request", () => {
    // Sun 2026-10-18; f2 requested 10:00–12:00, the BMS cooled f1 too
    const iv = series(
      "f1",
      "2026-10-18",
      "10:00",
      Array.from({ length: 8 }, () => ({ occ: 0, hvac: 1 })),
    );
    const approvedOvertime = [
      {
        floorId: "f2",
        start: at("2026-10-18", "10:00"),
        end: at("2026-10-18", "12:00"),
        mode: "full" as const,
      },
    ];
    const fs = run(iv, { approvedOvertime });
    expect(fs).toHaveLength(1);
    expect(fs[0]!.ruleId).toBe("hvac_unrequested_non_working");
    expect(fs[0]!.avoidableKwh).toBe(80); // no grace: nobody asked for this floor
    expect(fs[0]!.dayType).toBe("weekend");
    expect(fs[0]!.evidence.facts.requestingFloors).toBe(1);
  });

  it("says when the floor's own request had ended", () => {
    // Sun 2026-10-18; f1 requested 09:00–10:00, f2 10:00–12:00; the zone kept f1 cooled until 12:00
    const iv = series(
      "f1",
      "2026-10-18",
      "10:00",
      Array.from({ length: 8 }, () => ({ occ: 0, hvac: 1 })),
    );
    const approvedOvertime = [
      {
        floorId: "f1",
        start: at("2026-10-18", "09:00"),
        end: at("2026-10-18", "10:00"),
        mode: "full" as const,
      },
      {
        floorId: "f2",
        start: at("2026-10-18", "10:00"),
        end: at("2026-10-18", "12:00"),
        mode: "full" as const,
      },
    ];
    const [f] = run(iv, { approvedOvertime });
    expect(f!.ruleId).toBe("hvac_unrequested_non_working");
    expect(f!.evidence.facts.ownRequestEnded).toBe("10:00");
    expect(f!.evidence.summary).toContain("after its own request ended at 10:00");
    expect(f!.evidence.summary).not.toContain("no request of its own");
  });

  it("falls back to the empty-floor rule when no floor requested anything", () => {
    const iv = series(
      "f1",
      "2026-10-18",
      "10:00",
      Array.from({ length: 4 }, () => ({ occ: 0, hvac: 1 })),
    );
    const fs = run(iv);
    expect(fs.map((f) => f.ruleId)).toEqual(["hvac_empty_floor"]);
  });
});

describe("rule: lights on, floor empty at night", () => {
  it("flags lighting above the security level after the grace period", () => {
    const iv = series("f1", "2026-10-13", "23:00", [
      { occ: 0, lights: 0.6 },
      { occ: 0, lights: 0.6 },
      { occ: 0, lights: 0.6 },
      { occ: 0, lights: 0.1 },
    ]);
    const fs = run(iv, { params: { minFindingKwh: 0 } });
    expect(fs).toHaveLength(1);
    expect(fs[0]!.ruleId).toBe("lights_on_empty_night");
    expect(fs[0]!.avoidableKwh).toBeCloseTo(2 * 1.2);
  });
});

describe("rule: whole floor cooled for a few people", () => {
  it("is an opportunity after hours only, sized by the zone-only fraction", () => {
    const evening = series("f1", "2026-10-13", "20:00", [
      { occ: 2, hvac: 1 },
      { occ: 2, hvac: 1 },
      { occ: 5, hvac: 1 },
    ]);
    const fs = run(evening);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.kind).toBe("opportunity");
    expect(fs[0]!.avoidableKwh).toBeCloseTo(2 * 10 * 0.75);
    const lunch = series("f1", "2026-10-13", "12:00", [
      { occ: 1, hvac: 1 },
      { occ: 1, hvac: 1 },
    ]);
    expect(run(lunch)).toEqual([]);
  });
});

describe("rule parameters", () => {
  it("documents a rationale for every threshold", () => {
    for (const k of Object.keys(DEFAULT_RULE_PARAMS))
      expect(RULE_PARAM_RATIONALE[k as keyof typeof RULE_PARAM_RATIONALE]).toBeTruthy();
  });
});
