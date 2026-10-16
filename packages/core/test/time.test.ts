import { describe, expect, it } from "vitest";
import {
  addDays,
  Calendar,
  formatClock,
  inWindow,
  isoWeekdayOf,
  localParts,
  parseClock,
  zonedTime,
} from "../src";

describe("time", () => {
  it("round-trips local wall-clock time in Asia/Shanghai", () => {
    const ts = zonedTime("2026-10-13", 19 * 60 + 20, "Asia/Shanghai");
    expect(new Date(ts).toISOString()).toBe("2026-10-13T11:20:00.000Z");
    const p = localParts(ts, "Asia/Shanghai");
    expect(p.dateKey).toBe("2026-10-13");
    expect(p.minuteOfDay).toBe(19 * 60 + 20);
    expect(p.isoWeekday).toBe(2);
  });

  it("handles a DST zone", () => {
    // 2026-03-29 is the EU DST switch; 10:00 local in Berlin is 08:00Z
    expect(new Date(zonedTime("2026-03-29", 600, "Europe/Berlin")).toISOString()).toBe(
      "2026-03-29T08:00:00.000Z",
    );
  });

  it("parses and formats clock times, including windows across midnight", () => {
    expect(parseClock("23:00")).toBe(1380);
    expect(() => parseClock("25:00")).toThrow();
    expect(formatClock(-30)).toBe("23:30");
    expect(inWindow(30, parseClock("23:00"), parseClock("06:00"))).toBe(true);
    expect(inWindow(720, parseClock("23:00"), parseClock("06:00"))).toBe(false);
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(isoWeekdayOf("2026-10-18")).toBe(7);
  });
});

describe("calendar", () => {
  const cal = new Calendar({ holidays: ["2026-10-01"], workdays: ["2026-10-10"] });
  it("classifies holidays, weekends and make-up working days", () => {
    expect(cal.dayType("2026-10-01")).toBe("holiday");
    expect(cal.dayType("2026-10-11")).toBe("weekend");
    expect(cal.dayType("2026-10-10")).toBe("workday"); // Saturday make-up day
    expect(cal.dayType("2026-10-12")).toBe("workday");
  });
});
