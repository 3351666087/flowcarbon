import { describe, expect, it } from "vitest";
import {
  buildReport,
  type EmissionFactor,
  type Finding,
  findingParty,
  findingResponder,
  leasedOn,
  RESPONSIBILITY_DISCLOSURE,
  type RuleId,
  SYSTEM_PARTY_WHEN_LEASED,
  splitByParty,
} from "../src";
import { at, building, floor, series } from "./helpers";

const factor: EmissionFactor = {
  id: "f",
  region: "CN-East",
  year: 2023,
  method: "location",
  kgPerKwh: 0.5,
  source: "test",
  status: "verified",
};

describe("tenant-controlled vs building-controlled energy", () => {
  it("gives lighting and plug to the tenant and cooling to the building on a leased floor", () => {
    expect(splitByParty({ hvac: 10, lighting: 3, plug: 2 }, true)).toEqual({ tenant: 5, building: 10 });
  });

  it("gives everything to the building on a vacant floor", () => {
    expect(splitByParty({ hvac: 10, lighting: 3, plug: 2 }, false)).toEqual({ tenant: 0, building: 15 });
  });

  it("always adds up to the total", () => {
    for (const kwh of [
      { hvac: 0, lighting: 0, plug: 0 },
      { hvac: 1.25, lighting: 0.4, plug: 0.05 },
      { hvac: 0, lighting: 7, plug: 3 },
    ])
      for (const leased of [true, false]) {
        const s = splitByParty(kwh, leased);
        expect(s.tenant + s.building).toBeCloseTo(kwh.hvac + kwh.lighting + kwh.plug, 10);
      }
  });

  it("documents the mapping it uses", () => {
    expect(SYSTEM_PARTY_WHEN_LEASED).toEqual({ hvac: "building", lighting: "tenant", plug: "tenant" });
    expect(RESPONSIBILITY_DISCLOSURE).toMatch(/by system, not by metered area/);
    expect(RESPONSIBILITY_DISCLOSURE).toMatch(/not metered separately/);
  });
});

describe("who to call about a finding", () => {
  const rules: RuleId[] = [
    "hvac_empty_floor",
    "hvac_unrequested_non_working",
    "lights_on_empty_night",
    "full_floor_few_people",
  ];
  it.each(rules)("%s", (ruleId) => {
    const lights = ruleId === "lights_on_empty_night";
    expect(findingResponder(ruleId, true)).toBe(lights ? "tenant" : "engineering");
    expect(findingResponder(ruleId, false)).toBe("engineering");
    expect(findingParty(ruleId, true)).toBe(lights ? "tenant" : "building");
    expect(findingParty(ruleId, false)).toBe("building");
  });

  it("sends an unknown rule to engineering", () => {
    expect(findingResponder("something_new", true)).toBe("engineering");
  });
});

describe("leases by day", () => {
  const leases = [
    { floorId: "f1", startsOn: "2026-10-05", endsOn: "2026-10-10" },
    { floorId: "f2", startsOn: "2026-10-08", endsOn: null },
  ];
  it("includes both the first and the last day", () => {
    expect(leasedOn(leases, "f1", "2026-10-04")).toBe(false);
    expect(leasedOn(leases, "f1", "2026-10-05")).toBe(true);
    expect(leasedOn(leases, "f1", "2026-10-10")).toBe(true);
    expect(leasedOn(leases, "f1", "2026-10-11")).toBe(false);
  });
  it("treats an open-ended lease as running on", () => {
    expect(leasedOn(leases, "f2", "2026-10-07")).toBe(false);
    expect(leasedOn(leases, "f2", "2099-12-31")).toBe(true);
  });
  it("does not mix floors up", () => {
    expect(leasedOn(leases, "f3", "2026-10-09")).toBe(false);
  });
});

describe("report: who controls the energy", () => {
  // f1 leased throughout; f2 vacant until its lease starts on 2026-10-14 (mid-window)
  const f1 = floor("f1");
  const f2 = floor("f2", { tenantId: "t2" });
  const day = (floorId: string, dateKey: string) =>
    series(floorId, dateKey, "20:00", [
      { occ: 0, hvac: 1, lights: 1 },
      { occ: 0, hvac: 1, lights: 1 },
    ]).map((iv) => ({ ...iv, kwh: { hvac: 10, lighting: 2, plug: 1 } }));
  const intervals = [
    ...day("f1", "2026-10-13"),
    ...day("f1", "2026-10-14"),
    ...day("f2", "2026-10-13"),
    ...day("f2", "2026-10-14"),
  ];
  const finding = (floorId: string, ruleId: RuleId, dateKey: string, kwh: number): Finding => ({
    ruleId,
    kind: "waste",
    floorId,
    start: at(dateKey, "20:00"),
    end: at(dateKey, "20:30"),
    dayType: "workday",
    avoidableKwh: kwh,
    peakPeople: 0,
    tier: "measured",
    evidence: { summary: "", facts: {} },
  });
  const findings = [
    finding("f1", "lights_on_empty_night", "2026-10-13", 4),
    finding("f1", "hvac_empty_floor", "2026-10-13", 20),
    finding("f2", "lights_on_empty_night", "2026-10-13", 3), // vacant that day: engineering
    finding("f2", "lights_on_empty_night", "2026-10-14", 2), // leased from that day: the tenant
  ];
  const report = buildReport({
    building,
    floors: [f1, f2],
    intervals,
    findings,
    locationFactor: factor,
    from: at("2026-10-13", "00:00"),
    to: at("2026-10-15", "00:00"),
    leases: [
      { floorId: "f1", startsOn: "2024-01-01", endsOn: null },
      { floorId: "f2", startsOn: "2026-10-14", endsOn: null },
    ],
  });

  it("splits by the lease in force on each day", () => {
    const [tenant, bld] = report.byParty;
    expect(tenant!.party).toBe("tenant");
    expect(bld!.party).toBe("building");
    // per floor-day: 26 kWh = 20 cooling + 6 lighting/plug; tenant gets 6 on f1 both days and f2 on 10-14
    expect(tenant!.kwh).toBe(18);
    expect(bld!.kwh).toBe(104 - 18);
    expect(tenant!.kwh + bld!.kwh).toBeCloseTo(report.totals.kwh, 1);
    expect(tenant!.share + bld!.share).toBeCloseTo(1, 10);
    const f2row = report.byFloor.find((f) => f.floorId === "f2")!;
    expect(f2row.tenantKwh).toBe(6);
    expect(f2row.buildingKwh).toBe(46);
  });

  it("puts lights left on by a tenant on the tenant's side and the rest on the building's", () => {
    expect(report.byParty[0]!.avoidableKwh).toBe(4 + 2);
    expect(report.byParty[1]!.avoidableKwh).toBe(20 + 3);
    expect(report.byParty[0]!.avoidableKwh + report.byParty[1]!.avoidableKwh).toBeCloseTo(
      report.totals.avoidableKwh,
      1,
    );
  });

  it("falls back to the floor's current tenant when no leases are given", () => {
    const r = buildReport({
      building,
      floors: [f1, floor("f2", { tenantId: null })],
      intervals,
      findings: [],
      locationFactor: factor,
      from: at("2026-10-13", "00:00"),
      to: at("2026-10-15", "00:00"),
    });
    expect(r.byParty[0]!.kwh).toBe(12);
  });

  it("reports zero shares when there is no energy", () => {
    const r = buildReport({
      building,
      floors: [f1],
      intervals: [],
      findings: [],
      locationFactor: factor,
      from: at("2026-10-13", "00:00"),
      to: at("2026-10-14", "00:00"),
    });
    expect(r.byParty).toEqual([
      { party: "tenant", kwh: 0, share: 0, avoidableKwh: 0 },
      { party: "building", kwh: 0, share: 0, avoidableKwh: 0 },
    ]);
  });
});
