import { describe, expect, it } from "vitest";
import { compareNights } from "./night-compare";

const row = (floorId: string, day: string, kwhAfterHours: number) => ({ floorId, day, kwhAfterHours });

describe("compareNights", () => {
  it("compares the latest whole day with the same weekday a week earlier, biggest increase first", () => {
    const r = compareNights(
      [
        row("a", "2026-11-03", 10),
        row("a", "2026-11-10", 11),
        row("b", "2026-11-03", 10),
        row("b", "2026-11-10", 14),
        row("c", "2026-11-03", 0),
        row("c", "2026-11-10", 5),
      ],
      "2026-11-10",
      "2026-11-12",
    );
    expect(r?.latest).toBe("2026-11-10");
    expect(r?.prior).toBe("2026-11-03");
    expect(r?.floors.map((f) => f.floorId)).toEqual(["c", "b", "a"]);
    const [c, b, a] = r!.floors;
    expect(b).toMatchObject({ delta: 4, share: 0.4, high: true });
    expect(a).toMatchObject({ delta: 1, high: false });
    expect(c).toMatchObject({ share: null, high: true });
  });

  it("leaves out the day still coming in", () => {
    const r = compareNights(
      [row("a", "2026-11-04", 3), row("a", "2026-11-05", 1)],
      "2026-11-05",
      "2026-11-05",
    );
    expect(r?.latest).toBe("2026-11-04");
    expect(r?.floors[0]).toMatchObject({ latest: 3, prior: null, delta: null, high: false });
  });

  it("returns nothing without data", () => {
    expect(compareNights([], "2026-11-05", "2026-11-12")).toBeNull();
    expect(compareNights([row("a", "2026-11-05", 1)], null, "2026-11-12")).toBeNull();
  });
});
