import { describe, expect, it } from "vitest";
import {
  type EmissionFactor,
  emptyPartyTotals,
  partyRows,
  partyUnsplitRow,
  RESPONSIBILITY_DISCLOSURE,
  reportDisclosures,
  SIMULATED_DISCLOSURE,
} from "../src";

const factor: EmissionFactor = {
  id: "f",
  region: "CN-East",
  year: 2023,
  method: "location",
  kgPerKwh: 0.5703,
  source: "Ministry of Ecology and Environment",
  status: "verified",
};

describe("report disclosures", () => {
  it("lists the standard disclosures for a real building", () => {
    const d = reportDisclosures(factor, undefined, 0.75);
    expect(d).toHaveLength(6);
    expect(d[0]).toMatch(/^Boundary:/);
    expect(d[1]).toBe(RESPONSIBILITY_DISCLOSURE);
    expect(d).not.toContain(SIMULATED_DISCLOSURE);
    expect(d[5]).toContain("25 %");
  });

  it("says first that a simulated building's figures must not be used in a real report", () => {
    const d = reportDisclosures(factor, undefined, 0.75, { simulated: true });
    expect(d[0]).toBe("All figures come from a simulated building and must not be used in a real report.");
    expect(d).toHaveLength(7);
    expect(d.slice(1)).toEqual(reportDisclosures(factor, undefined, 0.75));
  });
});

describe("energy whose split by system is not known", () => {
  const acc = emptyPartyTotals();
  acc.tenant.kwh = 300;
  acc.building.kwh = 500;

  it("is a share of the whole, so tenant, building and unsplit add up to 1", () => {
    const rows = partyRows(acc, 200);
    const u = partyUnsplitRow(acc, 200, 3);
    expect(rows.map((r) => r.share)).toEqual([0.3, 0.5]);
    expect(u).toEqual({ kwh: 200, share: 0.2, floorDays: 3 });
    expect(rows[0]!.share + rows[1]!.share + u.share).toBeCloseTo(1, 12);
  });

  it("changes nothing when every day is split", () => {
    expect(partyRows(acc).map((r) => r.share)).toEqual([0.375, 0.625]);
    expect(partyUnsplitRow(acc, 0, 0)).toEqual({ kwh: 0, share: 0, floorDays: 0 });
    expect(
      reportDisclosures(factor, undefined, 0.75, { unsplit: { kwh: 0, share: 0, floorDays: 0 } }),
    ).toEqual(reportDisclosures(factor, undefined, 0.75));
  });

  it("is disclosed right after the responsibility note when there is any", () => {
    const d = reportDisclosures(factor, undefined, 0.75, { unsplit: { kwh: 200, share: 0.2, floorDays: 3 } });
    expect(d).toHaveLength(7);
    expect(d[1]).toBe(RESPONSIBILITY_DISCLOSURE);
    expect(d[2]).toBe(
      "200 kWh (20 % of the energy, on 3 floor-days) could not be split by system because those days' 15-minute data is no longer stored in full; it is reported as unsplit and counted as neither the tenant's nor the building's.",
    );
  });
});
