import { describe, expect, it } from "vitest";
import { chunkSpan, mergeSpans } from "../src/recompute";

describe("recompute spans", () => {
  it("merges overlapping and adjacent spans", () => {
    expect(
      mergeSpans([
        { fromDate: "2026-10-05", toDateExclusive: "2026-10-07" },
        { fromDate: "2026-10-01", toDateExclusive: "2026-10-03" },
        { fromDate: "2026-10-03", toDateExclusive: "2026-10-04" },
        { fromDate: "2026-10-06", toDateExclusive: "2026-10-06" },
      ]),
    ).toEqual([
      { fromDate: "2026-10-01", toDateExclusive: "2026-10-04" },
      { fromDate: "2026-10-05", toDateExclusive: "2026-10-07" },
    ]);
  });

  it("splits long backfills into bounded chunks", () => {
    const chunks = chunkSpan({ fromDate: "2026-09-01", toDateExclusive: "2026-10-01" }, 14);
    expect(chunks).toEqual([
      { fromDate: "2026-09-01", toDateExclusive: "2026-09-15" },
      { fromDate: "2026-09-15", toDateExclusive: "2026-09-29" },
      { fromDate: "2026-09-29", toDateExclusive: "2026-10-01" },
    ]);
  });
});
