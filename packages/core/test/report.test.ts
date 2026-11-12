import { describe, expect, it } from "vitest";
import { type EmissionFactor, reportDisclosures, SIMULATED_DISCLOSURE } from "../src";

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
    expect(d).toHaveLength(5);
    expect(d[0]).toMatch(/^Boundary:/);
    expect(d).not.toContain(SIMULATED_DISCLOSURE);
    expect(d[4]).toContain("25 %");
  });

  it("says first that a simulated building's figures must not be used in a real report", () => {
    const d = reportDisclosures(factor, undefined, 0.75, { simulated: true });
    expect(d[0]).toBe("All figures come from a simulated building and must not be used in a real report.");
    expect(d.slice(1)).toEqual(reportDisclosures(factor, undefined, 0.75));
  });
});
