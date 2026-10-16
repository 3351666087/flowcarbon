import { describe, expect, it } from "vitest";
import { buildFloorIntervals, occupancyFromDoorCounts } from "../src";
import { at, floor, TZ } from "./helpers";

describe("occupancy from door counts", () => {
  it("never goes negative and resets residual drift at night", () => {
    const q = 15 * 60_000;
    const t0 = at("2026-10-13", "17:00");
    const counts = [
      { floorId: "f1", start: t0, entries: 5, exits: 0 },
      { floorId: "f1", start: t0 + q, entries: 0, exits: 3 }, // two exits missed by the counter
      { floorId: "f1", start: t0 + 2 * q, entries: 0, exits: 9 }, // clamped at zero
    ];
    const pts = occupancyFromDoorCounts(counts, { timeZone: TZ }).get("f1")!;
    expect(pts.map((p) => p.count)).toEqual([5, 2, 0]);

    // residual 2 people with no movement late at night is cleared after the idle period
    const n0 = at("2026-10-13", "22:00");
    const night = [{ floorId: "f2", start: n0, entries: 2, exits: 0 }];
    for (let i = 1; i <= 10; i++) night.push({ floorId: "f2", start: n0 + i * q, entries: 0, exits: 0 });
    const np = occupancyFromDoorCounts(night, { timeZone: TZ }).get("f2")!;
    expect(np[0]!.count).toBe(2);
    const cleared = np.find((p) => p.driftCorrected);
    expect(cleared?.driftCorrected).toBe(2);
    expect(np.at(-1)!.count).toBe(0);
  });
});

describe("interval aggregation", () => {
  const f1 = floor("f1");
  const from = at("2026-10-13", "18:00");
  const to = from + 60 * 60_000;

  it("estimates from rated power when unmetered and marks the tier", () => {
    const iv = buildFloorIntervals({
      floors: [f1],
      from,
      to,
      hvacEvents: [
        { floorId: "f1", ts: from + 7.5 * 60_000, mode: "full" },
        { floorId: "f1", ts: from + 37.5 * 60_000, mode: "setback" },
      ],
      lightingEvents: [{ floorId: "f1", ts: from, level: 0.5 }],
      occupancy: [
        { floorId: "f1", ts: from, count: 4 },
        { floorId: "f1", ts: from + 20 * 60_000, count: 7 },
      ],
    });
    expect(iv).toHaveLength(4);
    expect(iv[0]!.hvacOn).toBeCloseTo(0.5);
    expect(iv[0]!.kwh.hvac).toBeCloseTo(40 * 0.25 * 0.5);
    expect(iv[2]!.hvacMode).toBe("full"); // 7.5 min full, 7.5 min setback → tie resolves to full
    expect(iv[3]!.hvacMode).toBe("setback");
    expect(iv[3]!.kwh.hvac).toBeCloseTo(40 * 0.25 * 0.25);
    expect(iv[1]!.occupancy).toBe(7);
    expect(iv[0]!.kwh.lighting).toBeCloseTo(8 * 0.25 * 0.5);
    expect(iv.every((i) => i.tier === "estimated")).toBe(true);
  });

  it("uses metered energy where a meter covers every system", () => {
    const iv = buildFloorIntervals({
      floors: [f1],
      from,
      to,
      readings: [
        { floorId: "f1", system: "hvac", start: from, end: to, kwh: 40 },
        { floorId: "f1", system: "lighting", start: from, end: from + 30 * 60_000, kwh: 6 },
        { floorId: "f1", system: "plug", start: from, end: to, kwh: 4 },
      ],
    });
    expect(iv.map((i) => i.kwh.hvac)).toEqual([10, 10, 10, 10]);
    // the lighting meter stops after 30 min: the rest is estimated (lights off here), not "measured zero"
    expect(iv.map((i) => i.kwh.lighting)).toEqual([3, 3, 0, 0]);
    expect(iv.map((i) => i.tier)).toEqual(["measured", "measured", "estimated", "estimated"]);
  });
});

describe("meter gaps", () => {
  it("falls back to the estimate where readings stop, instead of counting zero", () => {
    const floor = {
      id: "f1",
      label: "F1",
      level: 1,
      areaM2: 1000,
      tenantId: null,
      ratedHvacKw: 40,
      ratedLightingKw: 8,
      plugKwPerPerson: 0.1,
    };
    const from = Date.UTC(2026, 9, 12, 0, 0);
    const to = from + 2 * 3_600_000;
    const q = 15 * 60_000;
    // meters report only the first hour
    const readings = ["hvac", "lighting", "plug"].flatMap((system) =>
      [0, 1, 2, 3].map((i) => ({
        floorId: "f1",
        system: system as "hvac" | "lighting" | "plug",
        start: from + i * q,
        end: from + (i + 1) * q,
        kwh: 1,
      })),
    );
    const iv = buildFloorIntervals({
      floors: [floor],
      from,
      to,
      readings,
      hvacEvents: [{ floorId: "f1", ts: from, mode: "full" }],
      lightingEvents: [{ floorId: "f1", ts: from, level: 1 }],
    });
    expect(iv.slice(0, 4).every((i) => i.tier === "measured" && i.kwh.hvac === 1)).toBe(true);
    expect(iv.slice(4).every((i) => i.tier === "estimated")).toBe(true);
    expect(iv[4]!.kwh.hvac).toBeCloseTo(10, 6); // 40 kW for 15 min
    expect(iv[4]!.kwh.lighting).toBeCloseTo(2, 6);
  });
});
