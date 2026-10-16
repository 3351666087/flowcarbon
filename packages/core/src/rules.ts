import { Calendar, type DayType } from "./calendar";
import type { BuildingProfile, DataTier, FloorInterval, FloorProfile, OvertimeWindow } from "./model";
import { intervalEnd, round } from "./model";
import { formatClock, inWindow, localParts, parseClock } from "./time";

export type RuleId =
  | "hvac_empty_floor"
  | "hvac_unrequested_non_working"
  | "lights_on_empty_night"
  | "full_floor_few_people";

/** Waste is something nobody needed; an opportunity is a cheaper way to serve people who are there. */
export type FindingKind = "waste" | "opportunity";

export interface RuleParams {
  emptyGraceMinutes: number;
  lightsNightStart: string;
  lightsNightEnd: string;
  lightsMinLevel: number;
  lightsGraceMinutes: number;
  fullFloorMinPeople: number;
  minFindingKwh: number;
  startupWindowMinutes: number;
}

export const DEFAULT_RULE_PARAMS: RuleParams = {
  emptyGraceMinutes: 30,
  lightsNightStart: "23:00",
  lightsNightEnd: "06:00",
  lightsMinLevel: 0.2,
  lightsGraceMinutes: 15,
  fullFloorMinPeople: 3,
  minFindingKwh: 5,
  startupWindowMinutes: 60,
};

/** Why each threshold has the value it has. Shown next to every finding; reviewers asked for this explicitly. */
export const RULE_PARAM_RATIONALE: Record<keyof RuleParams, string> = {
  emptyGraceMinutes:
    "People step out briefly; a floor only counts as empty after this long. ASHRAE 90.1 has occupant sensors switch lighting off within 20 min of vacancy; 30 min is a deliberately more conservative value for cooling.",
  lightsNightStart: "After this local time no regular work is expected on office floors; set per building.",
  lightsNightEnd: "Cleaning and early arrivals start after this local time; set per building.",
  lightsMinLevel:
    "Below 20 % the remaining load is typically emergency and security lighting, which must stay on.",
  lightsGraceMinutes: "Allows for cleaners and security rounds passing through an empty floor.",
  fullFloorMinPeople:
    "With fewer people than this, conditioning one zone (setback) serves them; full-floor cooling is only justified above it. Default 3, to be validated with each property manager.",
  minFindingKwh:
    "Findings smaller than this are aggregated but not raised individually, to keep the list actionable.",
  startupWindowMinutes:
    "On working days, cooling within this many minutes before and after the start of the working day is pre-cooling and arrival, not waste: a floor needs 30–60 min to reach set-point and arrivals spread over the first hour.",
};

export interface RuleMeta {
  id: RuleId;
  kind: FindingKind;
  name: string;
  /** the physical fact the rule checks */
  physics: string;
  /** how avoidable energy is computed */
  quantification: string;
}

export const RULES: Record<RuleId, RuleMeta> = {
  hvac_unrequested_non_working: {
    id: "hvac_unrequested_non_working",
    kind: "waste",
    name: "Cooled on a non-working day without a request",
    physics:
      "On a weekend or holiday the floor's zone was cooled although this floor filed no overtime request and nobody was counted on it, while another floor did request cooling.",
    quantification: "All HVAC energy of the floor during those intervals.",
  },
  hvac_empty_floor: {
    id: "hvac_empty_floor",
    kind: "waste",
    name: "Cooling an empty floor",
    physics:
      "The floor's zone kept cooling after the people counter had shown nobody on the floor for longer than the grace period.",
    quantification:
      "HVAC energy of the floor from the end of the grace period until cooling stopped or someone returned.",
  },
  lights_on_empty_night: {
    id: "lights_on_empty_night",
    kind: "waste",
    name: "Lights on, floor empty at night",
    physics:
      "Lighting above the security level stayed on during night hours with nobody counted on the floor.",
    quantification: "Lighting energy of the floor after the grace period.",
  },
  full_floor_few_people: {
    id: "full_floor_few_people",
    kind: "opportunity",
    name: "Whole floor cooled for a few people",
    physics:
      "The whole floor was cooled while fewer people than the threshold were present; a zone setback would have served them.",
    quantification: "HVAC energy × (1 − zone-only fraction of the floor).",
  },
};

export interface Finding {
  ruleId: RuleId;
  kind: FindingKind;
  floorId: string;
  start: number;
  end: number;
  dayType: DayType;
  avoidableKwh: number;
  peakPeople: number;
  tier: DataTier;
  evidence: {
    summary: string;
    facts: Record<string, string | number>;
  };
}

interface Flag {
  rule: RuleId;
  kwh: number;
}

export interface RuleInput {
  building: BuildingProfile;
  floors: readonly FloorProfile[];
  /** any order; grouped per floor internally */
  intervals: readonly FloorInterval[];
  approvedOvertime?: readonly OvertimeWindow[];
  params?: Partial<RuleParams>;
}

function covered(windows: readonly OvertimeWindow[] | undefined, a: number, b: number): boolean {
  if (!windows) return false;
  return windows.some((w) => w.start < b && w.end > a);
}

/**
 * Runs all rules over the intervals. Each interval's HVAC energy is attributed to at most one rule
 * (precedence: unrequested non-working day → empty floor → few people), so totals never double count.
 * Lighting is evaluated separately.
 */
export function detectFindings(input: RuleInput): Finding[] {
  const p: RuleParams = { ...DEFAULT_RULE_PARAMS, ...input.params };
  const tz = input.building.timezone;
  const cal = new Calendar(input.building.calendar);
  const nightStart = parseClock(p.lightsNightStart);
  const nightEnd = parseClock(p.lightsNightEnd);
  const dayStart = parseClock(input.building.workdayStart);
  const afterHours = parseClock(input.building.afterHoursStart);
  const startupFrom = (dayStart - p.startupWindowMinutes + 1440) % 1440;
  const startupTo = (dayStart + p.startupWindowMinutes) % 1440;
  const floors = new Map(input.floors.map((f) => [f.id, f]));

  const byFloor = new Map<string, FloorInterval[]>();
  for (const i of input.intervals) {
    const l = byFloor.get(i.floorId);
    if (l) l.push(i);
    else byFloor.set(i.floorId, [i]);
  }
  const windowsByFloor = new Map<string, OvertimeWindow[]>();
  for (const w of input.approvedOvertime ?? []) {
    const l = windowsByFloor.get(w.floorId);
    if (l) l.push(w);
    else windowsByFloor.set(w.floorId, [w]);
  }

  const findings: Finding[] = [];
  for (const [floorId, list] of byFloor) {
    const floor = floors.get(floorId);
    if (!floor) continue;
    list.sort((a, b) => a.start - b.start);
    const own = windowsByFloor.get(floorId);
    const others = (input.approvedOvertime ?? []).filter((w) => w.floorId !== floorId);
    const zoneFraction = floor.zoneOnlyFraction ?? 0.3;

    let emptyMinutes = 0;
    let darkMinutes = 0;
    const hvacFlags: (Flag | null)[] = [];
    const lightFlags: (Flag | null)[] = [];

    for (const iv of list) {
      const end = intervalEnd(iv);
      const local = localParts(iv.start, tz);
      const dayType = cal.dayType(local.dateKey);
      const empty = iv.occupancy === 0;
      const workday = dayType === "workday";
      const startup = workday && inWindow(local.minuteOfDay, startupFrom, startupTo);
      const coreHours = workday && inWindow(local.minuteOfDay, dayStart, afterHours);

      // --- HVAC ---
      let hf: Flag | null = null;
      if (empty) {
        const before = emptyMinutes;
        emptyMinutes += iv.minutes;
        if (iv.hvacOn > 0 && !startup) {
          if (!workday && !covered(own, iv.start, end) && covered(others, iv.start, end)) {
            hf = { rule: "hvac_unrequested_non_working", kwh: iv.kwh.hvac };
          } else if (emptyMinutes > p.emptyGraceMinutes) {
            const share = Math.min(1, (emptyMinutes - Math.max(before, p.emptyGraceMinutes)) / iv.minutes);
            hf = { rule: "hvac_empty_floor", kwh: iv.kwh.hvac * share };
          }
        }
      } else {
        emptyMinutes = 0;
        if (
          !startup &&
          !coreHours &&
          iv.hvacOn > 0 &&
          iv.hvacMode === "full" &&
          iv.occupancy < p.fullFloorMinPeople
        ) {
          hf = { rule: "full_floor_few_people", kwh: iv.kwh.hvac * (1 - zoneFraction) };
        }
      }
      hvacFlags.push(hf && hf.kwh > 0 ? hf : null);

      // --- lighting ---
      let lf: Flag | null = null;
      if (empty && iv.lightsOn >= p.lightsMinLevel && inWindow(local.minuteOfDay, nightStart, nightEnd)) {
        const before = darkMinutes;
        darkMinutes += iv.minutes;
        if (darkMinutes > p.lightsGraceMinutes) {
          const share = Math.min(1, (darkMinutes - Math.max(before, p.lightsGraceMinutes)) / iv.minutes);
          lf = { rule: "lights_on_empty_night", kwh: iv.kwh.lighting * share };
        }
      } else darkMinutes = 0;
      lightFlags.push(lf && lf.kwh > 0 ? lf : null);
    }

    for (const flags of [hvacFlags, lightFlags]) {
      let k = 0;
      while (k < list.length) {
        const f = flags[k];
        if (!f) {
          k++;
          continue;
        }
        let j = k;
        let kwh = 0;
        let peak = 0;
        let estimated = false;
        while (
          j < list.length &&
          flags[j]?.rule === f.rule &&
          (j === k || list[j]!.start === intervalEnd(list[j - 1]!))
        ) {
          kwh += flags[j]!.kwh;
          peak = Math.max(peak, list[j]!.occupancy);
          estimated ||= list[j]!.tier === "estimated";
          j++;
        }
        const first = list[k]!;
        const last = list[j - 1]!;
        if (kwh >= p.minFindingKwh) {
          findings.push(
            makeFinding(
              f.rule,
              floor,
              first.start,
              intervalEnd(last),
              kwh,
              peak,
              estimated ? "estimated" : "measured",
              cal,
              tz,
              p,
              own,
              others,
            ),
          );
        }
        k = j;
      }
    }
  }
  return findings.sort((a, b) => a.start - b.start || a.floorId.localeCompare(b.floorId));
}

function makeFinding(
  rule: RuleId,
  floor: FloorProfile,
  start: number,
  end: number,
  kwh: number,
  peak: number,
  tier: DataTier,
  cal: Calendar,
  tz: string,
  p: RuleParams,
  own: readonly OvertimeWindow[] | undefined,
  others: readonly OvertimeWindow[],
): Finding {
  const a = localParts(start, tz);
  const b = localParts(end, tz);
  const hours = (end - start) / 3_600_000;
  const span = `${a.dateKey} ${formatClock(a.minuteOfDay)}–${formatClock(b.minuteOfDay)}`;
  const facts: Record<string, string | number> = {
    floor: floor.label,
    window: span,
    hours: round(hours, 2),
    avoidableKwh: round(kwh, 1),
    peakPeople: peak,
    dataTier: tier,
  };
  let summary: string;
  switch (rule) {
    case "hvac_unrequested_non_working": {
      const requesting = [
        ...new Set(others.filter((w) => w.start < end && w.end > start).map((w) => w.floorId)),
      ];
      facts.requestingFloors = requesting.length;
      // the floor may have had a request of its own earlier or later that day; say so instead of "no request"
      const sameDay = (own ?? []).filter((w) => localParts(w.start, tz).dateKey === a.dateKey);
      const ended = sameDay.filter((w) => w.end <= start).sort((x, y) => y.end - x.end)[0];
      const later = sameDay.filter((w) => w.start >= end).sort((x, y) => x.start - y.start)[0];
      let own$ = "with no request of its own";
      if (ended) {
        facts.ownRequestEnded = formatClock(localParts(ended.end, tz).minuteOfDay);
        own$ = `after its own request ended at ${facts.ownRequestEnded}`;
      } else if (later) {
        facts.ownRequestStarts = formatClock(localParts(later.start, tz).minuteOfDay);
        own$ = `before its own request started at ${facts.ownRequestStarts}`;
      }
      summary = `${floor.label} was cooled for ${round(hours, 1)} h on a non-working day (${span}) ${own$}, with nobody counted, while ${requesting.length} other floor(s) had approved overtime. Avoidable ${round(kwh, 0)} kWh.`;
      break;
    }
    case "hvac_empty_floor":
      facts.graceMinutes = p.emptyGraceMinutes;
      summary = `${floor.label} kept cooling with nobody on the floor (${span}). Counted after a ${p.emptyGraceMinutes}-min grace period. Avoidable ${round(kwh, 0)} kWh.`;
      break;
    case "lights_on_empty_night":
      facts.nightWindow = `${p.lightsNightStart}–${p.lightsNightEnd}`;
      summary = `Lights stayed on with nobody on ${floor.label} at night (${span}). Avoidable ${round(kwh, 0)} kWh.`;
      break;
    case "full_floor_few_people":
      facts.threshold = p.fullFloorMinPeople;
      facts.zoneOnlyFraction = floor.zoneOnlyFraction ?? 0.3;
      summary = `${floor.label} was cooled at full floor for at most ${peak} people (${span}); a zone setback would have served them. Avoidable ${round(kwh, 0)} kWh.`;
      break;
  }
  if (own?.some((w) => w.start < end && w.end > start)) facts.ownOvertimeApproved = "yes";
  return {
    ruleId: rule,
    kind: RULES[rule].kind,
    floorId: floor.id,
    start,
    end,
    dayType: cal.dayType(a.dateKey),
    avoidableKwh: kwh,
    peakPeople: peak,
    tier,
    evidence: { summary, facts },
  };
}
