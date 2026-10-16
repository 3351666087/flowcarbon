import {
  addDays,
  buildFloorIntervals,
  Calendar,
  type DoorCount,
  type EnergyReading,
  type HvacEvent,
  type HvacMode,
  type LightingEvent,
  MINUTE,
  type OvertimeWindow,
  occupancyFromDoorCounts,
  zonedTime,
} from "@flowcarbon/core";
import { Rng } from "./rng";
import type { SimBuilding, SimTenant } from "./tower";

export interface SimOvertime {
  id: string;
  tenantId: string;
  floorId: string;
  start: number;
  hours: number;
  expectedPeople: number;
  requestedAt: number;
  status: "approved";
}

export interface SimOutput {
  from: number;
  to: number;
  doorCounts: DoorCount[];
  hvacEvents: HvacEvent[];
  lightingEvents: LightingEvent[];
  readings: EnergyReading[];
  overtime: SimOvertime[];
}

export interface SimOptions {
  startDate: string;
  days: number;
  seed?: number;
  bucketMinutes?: number;
}

const H = 60 * MINUTE;

/** Behaviour of today's tower before FlowCarbon: fixed BMS schedules, whole-zone weekend cooling. */
export function simulate(sb: SimBuilding, opts: SimOptions): SimOutput {
  const rng = new Rng(opts.seed ?? 20261013);
  const tz = sb.building.timezone;
  const cal = new Calendar(sb.building.calendar);
  const bucket = (opts.bucketMinutes ?? 15) * MINUTE;
  const at = (dateKey: string, hour: number) => zonedTime(dateKey, Math.round(hour * 60), tz);
  const from = at(opts.startDate, 0);
  const to = at(addDays(opts.startDate, opts.days), 0);
  const tenantById = new Map(sb.tenants.map((t) => [t.id, t]));

  const moves = new Map<string, { ts: number; dir: 1 | -1 }[]>();
  const hvacEvents: HvacEvent[] = [];
  const lightingEvents: LightingEvent[] = [];
  const overtime: SimOvertime[] = [];
  const addMove = (floorId: string, ts: number, dir: 1 | -1) => {
    const l = moves.get(floorId);
    if (l) l.push({ ts, dir });
    else moves.set(floorId, [{ ts, dir }]);
  };
  const quarter = (h: number) => Math.round(h * 4) / 4;

  for (const f of sb.floors) {
    hvacEvents.push({ floorId: f.id, ts: from, mode: "off" });
    lightingEvents.push({ floorId: f.id, ts: from, level: 0.1 });
  }

  for (let d = 0; d < opts.days; d++) {
    const day = addDays(opts.startDate, d);
    const type = cal.dayType(day);
    const requests: SimOvertime[] = [];

    if (type !== "workday") {
      for (const t of sb.tenants) {
        const p = t.weekendRequestProb * (type === "holiday" ? 0.5 : 1);
        if (p > 0 && rng.chance(p)) {
          const startH = rng.pick([9, 9.5, 10]);
          const hours = rng.pick([5, 6, 7, 8]);
          const people = t.id === "t-northwind" ? rng.int(3, 12) : rng.int(2, 6);
          requests.push(req(t, t.floors[0]!, at(day, startH), hours, people, at(addDays(day, -1), 16)));
        }
      }
    }

    let zoneOn: { start: number; end: number } | null = null;
    if (type !== "workday" && requests.length) {
      const start = Math.min(...requests.map((r) => r.start));
      const hours = Math.max(...requests.map((r) => r.hours));
      zoneOn = { start, end: start + hours * H }; // as-is: the whole office zone runs for the longest request
    }

    for (const floor of sb.floors) {
      const tenant = floor.tenantId ? tenantById.get(floor.tenantId) : undefined;
      let firstIn = Number.POSITIVE_INFINITY;
      let lastOut = 0;
      const person = (arrive: number, leave: number) => {
        addMove(floor.id, arrive, 1);
        if (!rng.chance(0.01)) addMove(floor.id, leave, -1); // ~1 % of exits are missed by the counter
        firstIn = Math.min(firstIn, arrive);
        lastOut = Math.max(lastOut, leave);
      };

      if (type === "workday") {
        if (tenant) {
          const staff = Math.floor(tenant.headcountPerFloor * rng.uniform(0.78, 0.95));
          const [lo, hi, leaveLo, leaveHi] = tenant.overtime;
          const late = hi > 0 ? rng.int(lo, hi) : 0;
          for (let k = 0; k < staff; k++) {
            const arrive = Math.min(10.5, Math.max(7.5, rng.normal(8.75, 0.4)));
            const leave =
              k < late ? rng.uniform(leaveLo, leaveHi) : Math.min(18.9, Math.max(17, rng.normal(17.9, 0.35)));
            if (rng.chance(0.4)) {
              const out = rng.normal(12.1, 0.2);
              const back = out + rng.uniform(0.75, 1.25);
              person(at(day, arrive), at(day, out));
              person(at(day, back), at(day, leave));
            } else person(at(day, arrive), at(day, leave));
          }
          // F12 is the only floor whose tenant books extensions past the 20:00 BMS cut-off
          if (tenant.id === "t-northwind" && floor.id === tenant.floors[0] && late > 0 && rng.chance(0.6)) {
            const leaveH = (lastOut - at(day, 0)) / H;
            if (leaveH > 20) {
              const hours = quarter(Math.min(leaveH, 23) - 20);
              if (hours > 0)
                requests.push(
                  req(tenant, floor.id, at(day, 20), hours, Math.max(3, Math.floor(late / 3)), at(day, 15)),
                );
            }
          }
        }
        // as-is BMS: whole office zone 07:30–20:00; vacant floors kept at setback
        hvacEvents.push({ floorId: floor.id, ts: at(day, 7.5), mode: tenant ? "full" : "setback" });
        const ext = requests.find((r) => r.floorId === floor.id);
        hvacEvents.push({
          floorId: floor.id,
          ts: ext ? ext.start + ext.hours * H : at(day, 20),
          mode: "off",
        });
        if (tenant && Number.isFinite(firstIn)) {
          lightingEvents.push({ floorId: floor.id, ts: firstIn - 5 * MINUTE, level: 1 });
          const offAt = lastOut + 10 * MINUTE;
          if (tenant.id === "t-orchid" && rng.chance(0.25)) {
            lightingEvents.push({ floorId: floor.id, ts: offAt, level: 0.6 }); // left on overnight
            lightingEvents.push({ floorId: floor.id, ts: at(addDays(day, 1), 8), level: 0.1 });
          } else lightingEvents.push({ floorId: floor.id, ts: offAt, level: 0.1 });
        }
      } else {
        const mine = requests.find((r) => r.floorId === floor.id);
        if (mine) {
          for (let k = 0; k < mine.expectedPeople; k++) {
            const arrive = mine.start + rng.uniform(0, 0.5) * H;
            const leave = mine.start + (mine.hours - rng.uniform(0, 0.5)) * H;
            person(arrive, leave);
          }
          lightingEvents.push({ floorId: floor.id, ts: firstIn - 5 * MINUTE, level: 1 });
          lightingEvents.push({ floorId: floor.id, ts: lastOut + 10 * MINUTE, level: 0.1 });
        }
        if (zoneOn) {
          const mode: HvacMode = tenant ? "full" : "setback";
          hvacEvents.push({ floorId: floor.id, ts: zoneOn.start, mode });
          hvacEvents.push({ floorId: floor.id, ts: zoneOn.end, mode: "off" });
        }
      }
    }
    overtime.push(...requests);
  }

  // door counts per bucket
  const doorCounts: DoorCount[] = [];
  for (const floor of sb.floors) {
    const list = (moves.get(floor.id) ?? []).sort((a, b) => a.ts - b.ts);
    let k = 0;
    for (let start = from; start < to; start += bucket) {
      let entries = 0;
      let exits = 0;
      while (k < list.length && list[k]!.ts < start + bucket) {
        if (list[k]!.ts >= start) list[k]!.dir === 1 ? entries++ : exits++;
        k++;
      }
      doorCounts.push({ floorId: floor.id, start, entries, exits });
    }
  }

  // sub-meter readings on refurbished floors: physics estimate × weather factor × noise
  const occ = occupancyFromDoorCounts(doorCounts, { timeZone: tz, bucketMinutes: bucket / MINUTE });
  const occupancy = [...occ].flatMap(([floorId, pts]) =>
    pts.map((p) => ({ floorId, ts: p.start, count: p.count })),
  );
  const est = buildFloorIntervals({
    floors: sb.floors.filter((f) => sb.meteredFloors.includes(f.id)),
    from,
    to,
    bucketMinutes: bucket / MINUTE,
    hvacEvents,
    lightingEvents,
    occupancy,
  });
  const readings: EnergyReading[] = [];
  const meterRng = new Rng((opts.seed ?? 20261013) ^ 0x5eed);
  for (const iv of est) {
    const dayIdx = Math.floor((iv.start - from) / (24 * H));
    const weather = 1.1 - 0.25 * (dayIdx / Math.max(1, opts.days - 1)); // mid-September warmer than mid-October
    const end = iv.start + iv.minutes * MINUTE;
    const noise = () => 1 + meterRng.normal(0, 0.03);
    readings.push({
      floorId: iv.floorId,
      system: "hvac",
      start: iv.start,
      end,
      kwh: Math.max(0, iv.kwh.hvac * weather * noise()),
    });
    readings.push({
      floorId: iv.floorId,
      system: "lighting",
      start: iv.start,
      end,
      kwh: Math.max(0, iv.kwh.lighting * noise()),
    });
    readings.push({
      floorId: iv.floorId,
      system: "plug",
      start: iv.start,
      end,
      kwh: (iv.kwh.plug + 0.4 * (iv.minutes / 60)) * noise(),
    });
  }

  return { from, to, doorCounts, hvacEvents, lightingEvents, readings, overtime };

  function req(
    t: SimTenant,
    floorId: string,
    start: number,
    hours: number,
    people: number,
    requestedAt: number,
  ): SimOvertime {
    return {
      id: `ot-${new Date(start).toISOString().slice(0, 10)}-${floorId}`,
      tenantId: t.id,
      floorId,
      start,
      hours,
      expectedPeople: people,
      requestedAt,
      status: "approved",
    };
  }
}

export function approvedWindows(overtime: readonly SimOvertime[]): OvertimeWindow[] {
  return overtime.map((o) => ({
    floorId: o.floorId,
    start: o.start,
    end: o.start + o.hours * H,
    mode: o.expectedPeople >= 3 ? "full" : "setback",
  }));
}
