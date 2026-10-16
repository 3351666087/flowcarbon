import { isoWeekdayOf } from "./time";

export type DayType = "workday" | "weekend" | "holiday";

/**
 * Working calendar of a building. Public holidays and make-up working days (common in mainland China)
 * are data, imported per building, never hard-coded.
 */
export interface WorkCalendar {
  /** dateKeys (YYYY-MM-DD) that are public holidays */
  holidays: readonly string[];
  /** dateKeys that fall on a weekend but are working days (make-up days) */
  workdays: readonly string[];
  /** ISO weekdays that are normally non-working; default Saturday and Sunday */
  weekendDays?: readonly number[];
}

export const EMPTY_CALENDAR: WorkCalendar = { holidays: [], workdays: [] };

export class Calendar {
  private readonly holidays: Set<string>;
  private readonly workdays: Set<string>;
  private readonly weekend: Set<number>;

  constructor(cal: WorkCalendar = EMPTY_CALENDAR) {
    this.holidays = new Set(cal.holidays);
    this.workdays = new Set(cal.workdays);
    this.weekend = new Set(cal.weekendDays ?? [6, 7]);
  }

  dayType(dateKey: string): DayType {
    if (this.holidays.has(dateKey)) return "holiday";
    if (this.workdays.has(dateKey)) return "workday";
    return this.weekend.has(isoWeekdayOf(dateKey)) ? "weekend" : "workday";
  }

  isWorkday(dateKey: string): boolean {
    return this.dayType(dateKey) === "workday";
  }
}
