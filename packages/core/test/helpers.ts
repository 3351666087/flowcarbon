import type { BuildingProfile, FloorInterval, FloorProfile } from "../src";
import { zonedTime } from "../src";

export const TZ = "Asia/Shanghai";

export const building: BuildingProfile = {
  id: "b1",
  name: "Test Tower",
  timezone: TZ,
  currency: "CNY",
  workdayStart: "08:00",
  afterHoursStart: "18:00",
  tariff: { kind: "flat", rate: 1 },
  calendar: { holidays: ["2026-10-01"], workdays: ["2026-10-10"] },
  gridRegion: "CN-East",
};

export const floor = (id: string, extra: Partial<FloorProfile> = {}): FloorProfile => ({
  id,
  label: id.toUpperCase(),
  level: 1,
  areaM2: 1600,
  tenantId: "t1",
  ratedHvacKw: 40,
  ratedLightingKw: 8,
  plugKwPerPerson: 0.1,
  zoneOnlyFraction: 0.25,
  ...extra,
});

export const at = (dateKey: string, hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return zonedTime(dateKey, h * 60 + m, TZ);
};

/** Builds consecutive 15-min intervals from compact specs. */
export function series(
  floorId: string,
  dateKey: string,
  startHHMM: string,
  specs: {
    occ: number;
    hvac?: number;
    mode?: "full" | "setback" | "off";
    lights?: number;
    kwhHvac?: number;
    kwhLight?: number;
  }[],
): FloorInterval[] {
  const t0 = at(dateKey, startHHMM);
  return specs.map((s, i) => {
    const hvacOn = s.hvac ?? 0;
    return {
      floorId,
      start: t0 + i * 15 * 60_000,
      minutes: 15,
      occupancy: s.occ,
      hvacOn,
      hvacMode: s.mode ?? (hvacOn > 0 ? "full" : "off"),
      lightsOn: s.lights ?? 0,
      kwh: { hvac: s.kwhHvac ?? hvacOn * 10, lighting: s.kwhLight ?? (s.lights ?? 0) * 2, plug: 0 },
      tier: "measured",
    };
  });
}
