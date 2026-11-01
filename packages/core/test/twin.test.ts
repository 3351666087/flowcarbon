import { describe, expect, it } from "vitest";
import {
  brightnessAt,
  DEFAULT_RULE_PARAMS,
  DESK_TO_CEILING_M,
  driftC,
  evaluateTwin,
  illuminance,
  occupiedPolicy,
  placePeople,
  policyForStrategies,
  ROW_SPACING_M,
  seatOrder,
  type TwinFixture,
  type TwinLayout,
  type TwinSeat,
  twinLayout,
  twinPolicies,
} from "../src";
import { floor } from "./helpers";

// rated as the demo tower: 12.8 kW of lights, 56 kW of cooling
const rated = floor("f1", { ratedLightingKw: 12.8, ratedHvacKw: 56, zoneOnlyFraction: 0.3 });
const AREAS = [60, 200, 800, 1600, 5000];

const fixture = (id: string, x: number, y: number, group = id, space = "floor"): TwinFixture => ({
  id,
  x,
  y,
  group,
  space,
});
const within = (seat: TwinSeat, g: { x: number; y: number; width: number; depth: number }) =>
  seat.x >= g.x && seat.x <= g.x + g.width && seat.y >= g.y && seat.y <= g.y + g.depth;
const seatIn = (layout: TwinLayout, group: string) => {
  const seats = layout.seats.filter((s) => s.group === group);
  return seats[Math.floor(seats.length / 2)]!;
};
const uniqueIds = (items: readonly { id: string }[]) => new Set(items.map((i) => i.id)).size === items.length;

describe("floor layouts", () => {
  it.each(AREAS)("lays out %i m² of open plan in rows about 2.4 m apart", (area) => {
    const layout = twinLayout(area, "open_plan");
    expect(layout.width * layout.depth).toBeCloseTo(area, 6);
    expect(layout.groups.every((g) => g.kind === "row")).toBe(true);

    const gap = layout.depth / layout.groups.length;
    expect(gap).toBeGreaterThanOrEqual(area > 100 ? 2.1 : 2);
    expect(gap).toBeLessThanOrEqual(ROW_SPACING_M * 1.25);

    // every row is switched as one and every desk sits right under its row
    const perRow = layout.fixtures.filter((f) => f.group === "row-1").length;
    expect(layout.fixtures).toHaveLength(layout.groups.length * perRow);
    for (const seat of layout.seats) {
      const row = layout.groups.find((g) => g.id === seat.group)!;
      expect(seat.y).toBeCloseTo(row.y + row.depth / 2, 6);
      expect(within(seat, layout.zones.find((z) => z.id === seat.zone)!)).toBe(true);
    }
    expect(uniqueIds(layout.seats) && uniqueIds(layout.fixtures) && uniqueIds(layout.zones)).toBe(true);
  });

  it("gives the demo floor a plausible plant: about 46 W a light and 100 m² a fan coil", () => {
    const layout = twinLayout(1600, "open_plan");
    expect(layout.groups).toHaveLength(14);
    expect(layout.fixtures).toHaveLength(280);
    expect((12_800 / layout.fixtures.length).toFixed(0)).toBe("46");
    expect(layout.zones).toHaveLength(15);
    // more desks than the 140 people the busiest tenant puts on a floor
    expect(layout.seats.length).toBeGreaterThan(140);
  });

  it.each(AREAS)("lays out %i m² of meeting rooms along corridors", (area) => {
    const layout = twinLayout(area, "meeting_rooms");
    const rooms = layout.groups.filter((g) => g.kind === "room");
    const corridors = layout.groups.filter((g) => g.kind === "corridor");
    expect(corridors.length).toBeGreaterThan(0);

    // rooms and corridors fill the floor without overlapping
    const areaOf = (g: { width: number; depth: number }) => g.width * g.depth;
    expect([...rooms, ...corridors].reduce((sum, g) => sum + areaOf(g), 0)).toBeCloseTo(area, 6);

    // each room has its own fan coil, lights and seats
    expect(layout.zones.map((z) => z.id)).toEqual(rooms.map((r) => r.id));
    for (const room of rooms) {
      const lights = layout.fixtures.filter((f) => f.group === room.id);
      const seats = layout.seats.filter((s) => s.group === room.id);
      expect(lights.length).toBeGreaterThan(0);
      expect(lights.every((f) => f.space === room.id)).toBe(true);
      expect(seats.length).toBeGreaterThanOrEqual(2);
      expect(seats.every((s) => within(s, room) && s.zone === room.id && s.space === room.id)).toBe(true);
    }
    expect(uniqueIds(layout.seats) && uniqueIds(layout.fixtures)).toBe(true);
  });

  it("keeps rooms a realistic size on a deep floor by adding corridors", () => {
    const rooms = twinLayout(5000, "meeting_rooms").groups.filter((g) => g.kind === "room");
    for (const room of rooms) {
      expect(room.width).toBeLessThan(8);
      expect(room.depth).toBeLessThan(6);
    }
  });

  it("does not model a huge floor at full size", () => {
    const layout = twinLayout(1_000_000, "open_plan");
    expect(layout.areaM2).toBeLessThan(1_000_000);
    expect(layout.fixtures.length).toBeLessThan(2_000);
  });
});

describe("light model", () => {
  const at = { x: 0, y: 0, space: "floor" };

  it("is 1/h² straight under a source", () => {
    expect(DESK_TO_CEILING_M).toBe(2);
    expect(illuminance(at, [fixture("a", 0, 0)])).toBeCloseTo(0.25, 10);
  });

  it("matches a sum worked by hand", () => {
    // 2 m away at h = 2: θ = 45°, cos³θ = 0.353553, E = 0.353553 / 4 = 0.088388
    // 2 m and 1.5 m away: r = √(4 + 2.25 + 4) = 3.201562, cos θ = 0.624695, cos³θ = 0.243781, E = 0.060945
    const three = [fixture("a", 0, 0), fixture("b", 2, 0), fixture("c", 2, 1.5)];
    expect(illuminance(at, three)).toBeCloseTo(0.25 + 0.088388 + 0.060945, 5);
  });

  it("is a share of the same desk with everything on", () => {
    // 0.25 of 0.25 + 2 × 0.088388 = 0.426777
    const lights = [fixture("a", 0, 0), fixture("b", 2, 0), fixture("c", -2, 0)];
    expect(brightnessAt(at, lights, new Set(["a"]))).toBeCloseTo(0.585786, 5);
    expect(brightnessAt(at, lights, new Set(["a", "b", "c"]))).toBe(1);
    expect(brightnessAt(at, lights, new Set())).toBe(0);
  });

  it("stops at walls", () => {
    const lights = [fixture("a", 0, 0, "a", "room-1"), fixture("b", 1, 0, "b", "room-2")];
    expect(illuminance({ ...at, space: "room-1" }, lights)).toBeCloseTo(0.25, 10);
    expect(brightnessAt({ ...at, space: "room-1" }, lights, new Set(["a"]))).toBe(1);
    expect(brightnessAt({ ...at, space: "room-1" }, lights, new Set(["b"]))).toBe(0);
  });

  it("has nothing to say about a desk with no light in its space", () => {
    expect(brightnessAt({ ...at, space: "void" }, [fixture("a", 0, 0)], new Set(["a"]))).toBe(0);
  });
});

describe("policies", () => {
  const open = twinLayout(1600, "open_plan");
  const rooms = twinLayout(1600, "meeting_rooms");
  const room1 = seatIn(rooms, "room-1");
  const room2 = seatIn(rooms, "room-2");

  it("offers each template the policy that follows people there", () => {
    expect(twinPolicies("open_plan")).toEqual(["all_on", "occupied_rows", "away"]);
    expect(twinPolicies("meeting_rooms")).toEqual(["all_on", "rooms_in_use", "away"]);
  });

  it("all on: everything runs and nobody loses light", () => {
    const seat = seatIn(open, "row-3");
    const r = evaluateTwin(rated, open, "all_on", [seat.id]);
    expect(r.litFixtures).toBe(open.fixtures.length);
    expect(r.fanCoilsOn).toBe(open.zones.length);
    expect(r.after).toEqual(r.before);
    expect(r.seats).toEqual([{ seatId: seat.id, brightness: 1 }]);
  });

  it("rows around seated people: the row above and one either side stay on, the others go off", () => {
    const seat = seatIn(open, "row-7");
    const r = evaluateTwin(rated, open, "occupied_rows", [seat.id]);
    expect(r.litGroups.sort()).toEqual(["row-6", "row-7", "row-8"]);
    expect(r.litFixtures).toBe(60);
    expect(r.fanCoilsOn).toBe(1);
    expect(r.zonesOn).toEqual([seat.zone]);
  });

  it("gives a seat under its lit rows what the geometry gives, not a set figure", () => {
    const mid = seatIn(open, "row-7");
    const side = seatIn(open, "row-1");
    const brightness = (seat: TwinSeat) =>
      evaluateTwin(rated, open, "occupied_rows", [seat.id]).worstSeat!.brightness;

    // the same sum done directly, from the rows' own fixtures over all of them
    const kept = open.fixtures.filter((f) => ["row-6", "row-7", "row-8"].includes(f.group));
    const expected = illuminance(mid, kept) / illuminance(mid, open.fixtures);
    expect(brightness(mid)).toBeCloseTo(expected, 12);

    // what a bank of rows gives three rows in the middle of the floor, and two along the wall with less light to lose
    expect(brightness(mid)).toBeCloseTo(0.741, 3);
    expect(brightness(side)).toBeCloseTo(0.797, 3);
  });

  it("stays around 70 % or better at every desk with only one person on the floor", () => {
    for (const seat of open.seats) {
      const { worstSeat } = evaluateTwin(rated, open, "occupied_rows", [seat.id]);
      expect(worstSeat!.brightness).toBeGreaterThan(0.7);
    }
  });

  it("lights the same rows for several people under one row, and more for two rows of people", () => {
    const row = open.seats.filter((s) => s.group === "row-5");
    const shared = evaluateTwin(rated, open, "occupied_rows", [row[0]!.id, row[1]!.id]);
    expect(shared.litGroups.sort()).toEqual(["row-4", "row-5", "row-6"]);

    const a = seatIn(open, "row-5");
    const b = seatIn(open, "row-6");
    const both = evaluateTwin(rated, open, "occupied_rows", [a.id, b.id]);
    expect(both.litGroups.sort()).toEqual(["row-4", "row-5", "row-6", "row-7"]);
    // each desk also gets light from the row next to it
    expect(both.worstSeat!.brightness).toBeGreaterThan(
      evaluateTwin(rated, open, "occupied_rows", [a.id]).worstSeat!.brightness,
    );
  });

  it("rooms in use: a used room keeps full light, the corridor stays on, other rooms go off", () => {
    const r = evaluateTwin(rated, rooms, "rooms_in_use", [room1.id]);
    const corridors = rooms.groups.filter((g) => g.kind === "corridor").map((g) => g.id);
    expect(r.litGroups.sort()).toEqual(["room-1", ...corridors].sort());
    expect(r.seats[0]!.brightness).toBe(1);
    expect(r.fanCoilsOn).toBe(1);
    expect(evaluateTwin(rated, rooms, "rooms_in_use", [room1.id, room2.id]).fanCoilsOn).toBe(2);
  });

  it("away: keeps evenly spaced rows no higher than the security level", () => {
    const r = evaluateTwin(rated, open, "away", []);
    expect(r.litGroups).toEqual(["row-4", "row-11"]);
    expect(r.litFixtures / open.fixtures.length).toBeLessThanOrEqual(DEFAULT_RULE_PARAMS.lightsMinLevel);
    expect(r.fanCoilsOn).toBe(0);
    expect(r.after.hvacKw).toBe(0);
    expect(r.after.lightingKw).toBeCloseTo((12.8 * 40) / 280, 6);
  });

  it("away: keeps a floor of rooms lit in its corridors only", () => {
    const r = evaluateTwin(rated, rooms, "away", [room1.id]);
    expect(r.litGroups.every((g) => g.startsWith("corridor"))).toBe(true);
    expect(r.litFixtures / rooms.fixtures.length).toBeLessThanOrEqual(DEFAULT_RULE_PARAMS.lightsMinLevel);
    // someone left in a room is in the dark, and it says so; their fan coil still runs
    expect(r.worstSeat).toEqual({ seatId: room1.id, brightness: 0 });
    expect(r.fanCoilsOn).toBe(1);
  });

  it("keeps a lit row on the smallest floors", () => {
    const small = twinLayout(10, "open_plan");
    expect(evaluateTwin(rated, small, "away", []).litFixtures).toBeGreaterThan(0);
  });

  it("ignores a seat the layout does not have", () => {
    const seat = seatIn(open, "row-2");
    const r = evaluateTwin(rated, open, "occupied_rows", [seat.id, "room-3-seat-1"]);
    expect(r.seats).toHaveLength(1);
    expect(r.litGroups.sort()).toEqual(["row-1", "row-2", "row-3"]);
  });

  it("finds the worst seat among several", () => {
    const mid = seatIn(open, "row-7");
    const wall = seatIn(open, "row-1");
    const r = evaluateTwin(rated, open, "occupied_rows", [wall.id, mid.id]);
    expect(new Set(r.seats.map((s) => s.seatId))).toEqual(new Set([wall.id, mid.id]));
    expect(r.worstSeat!.seatId).toBe(mid.id);
  });
});

describe("power", () => {
  const open = twinLayout(1600, "open_plan");

  it("takes before from the floor's rated power", () => {
    const { before } = evaluateTwin(rated, open, "occupied_rows", []);
    expect(before).toEqual({ lightingKw: 12.8, hvacKw: 56, totalKw: 68.8 });
  });

  it("scales lighting with the lights left on", () => {
    const seat = seatIn(open, "row-7");
    const { after } = evaluateTwin(rated, open, "occupied_rows", [seat.id]);
    // three rows of 14: 12.8 × 3 / 14 = 2.743 kW; one fan coil of 15 is below the 30 % the plant runs at, so 16.8 kW
    expect(after.lightingKw).toBeCloseTo(2.7429, 3);
    expect(after.hvacKw).toBeCloseTo(16.8, 6);
    expect(after.totalKw).toBeCloseTo(19.5429, 3);
  });

  it("scales cooling with the fan coils running once they pass the zone-only share", () => {
    // one person in each zone: all of them run
    const onePerZone = open.zones.map((z) => open.seats.find((s) => s.zone === z.id)!.id);
    const all = evaluateTwin(rated, open, "occupied_rows", onePerZone);
    expect(all.fanCoilsOn).toBe(15);
    expect(all.after.hvacKw).toBeCloseTo(56, 6);

    // 9 of 15 is 60 %: 33.6 kW
    const some = evaluateTwin(rated, open, "occupied_rows", onePerZone.slice(0, 9));
    expect(some.fanCoilsOn).toBe(9);
    expect(some.after.hvacKw).toBeCloseTo(33.6, 6);
  });

  it("uses the floor's own zone-only share, and the usual 30 % where it has none", () => {
    const seat = seatIn(open, "row-7");
    const lean = floor("f2", { ratedHvacKw: 56, zoneOnlyFraction: 0.1 });
    expect(evaluateTwin(lean, open, "occupied_rows", [seat.id]).after.hvacKw).toBeCloseTo(5.6, 6);
    const unset = { ...lean, zoneOnlyFraction: undefined };
    expect(evaluateTwin(unset, open, "occupied_rows", [seat.id]).after.hvacKw).toBeCloseTo(16.8, 6);
  });
});

describe("a floor with no people", () => {
  it("open_plan: occupied_rows switches everything off", () => {
    const r = evaluateTwin(rated, twinLayout(1600, "open_plan"), "occupied_rows", []);
    expect(r.litGroups).toEqual([]);
    expect(r.litFixtures).toBe(0);
    expect(r.fanCoilsOn).toBe(0);
    expect(r.after).toEqual({ lightingKw: 0, hvacKw: 0, totalKw: 0 });
    expect(r.before.totalKw).toBeCloseTo(68.8, 6);
    expect(r.seats).toEqual([]);
    expect(r.worstSeat).toBeNull();
  });

  it("meeting_rooms: rooms_in_use keeps the corridors lit and nothing else", () => {
    const layout = twinLayout(1600, "meeting_rooms");
    const r = evaluateTwin(rated, layout, "rooms_in_use", []);
    const corridors = layout.groups.filter((g) => g.kind === "corridor").map((g) => g.id);
    expect(corridors.length).toBeGreaterThan(0);
    expect(r.litGroups).toEqual(corridors);
    expect(r.litFixtures).toBeGreaterThan(0);
    expect(r.fanCoilsOn).toBe(0);
    expect(r.after.hvacKw).toBe(0);
    expect(r.worstSeat).toBeNull();
    // the same corridors as with nobody expected at all, so an empty floor is never darker than "away"
    expect(r.litFixtures).toBe(evaluateTwin(rated, layout, "away", []).litFixtures);
  });

  it("has no seat to report under any policy", () => {
    for (const policy of twinPolicies("open_plan")) {
      const r = evaluateTwin(rated, twinLayout(800, "open_plan"), policy, []);
      expect(r.seats).toEqual([]);
      expect(r.worstSeat).toBeNull();
    }
  });
});

describe("what an empty zone does", () => {
  it("drifts as a first-order rise towards where it would settle", () => {
    expect(driftC(0)).toBe(0);
    // 6 × (1 − e^(−1/3)) = 6 × 0.283469 = 1.70081
    expect(driftC(1)).toBeCloseTo(1.70081, 4);
    // 6 × (1 − e^(−2/3)) = 6 × 0.486583 = 2.91950
    expect(driftC(2)).toBeCloseTo(2.9195, 4);
    expect(driftC(500)).toBeCloseTo(6, 6);
    expect(driftC(3, { settleC: 4, tauHours: 3 })).toBeCloseTo(4 * (1 - 1 / Math.E), 6);
  });
});

describe("seating people", () => {
  const layout = twinLayout(800, "open_plan");
  const id = "2f6c8a10-6b1f-4c1e-9d55-0a0a7d0c1b11";

  it("seats the same people in the same places every time", () => {
    expect(placePeople(layout, 12, id)).toEqual(placePeople(layout, 12, id));
    expect(placePeople(layout, 12, id)).not.toEqual(placePeople(layout, 12, "another-floor"));
  });

  it("gives nobody the same desk, and keeps people where they are as the count rises", () => {
    const seated = placePeople(layout, 40, id);
    expect(new Set(seated).size).toBe(40);
    expect(seated.slice(0, 12)).toEqual(placePeople(layout, 12, id));
  });

  it("copes with no people and with more people than desks", () => {
    expect(placePeople(layout, 0, id)).toEqual([]);
    expect(placePeople(layout, -3, id)).toEqual([]);
    expect(placePeople(layout, 10_000, id)).toHaveLength(layout.seats.length);
  });

  it("orders every seat once", () => {
    expect([...seatOrder(layout, id)].sort()).toEqual(layout.seats.map((s) => s.id).sort());
  });

  it("spreads people over the floor rather than along the first rows", () => {
    const rows = new Set(
      placePeople(layout, 10, id).map((seat) => layout.seats.find((s) => s.id === seat)!.group),
    );
    expect(rows.size).toBeGreaterThan(3);
  });
});

describe("matching a policy to a measure in effect", () => {
  it("maps cooling that follows people to the policy that follows people", () => {
    expect(policyForStrategies("open_plan", ["occupancy_gated_workday"])).toBe("occupied_rows");
    expect(policyForStrategies("meeting_rooms", ["zone_only_non_working"])).toBe("rooms_in_use");
    expect(occupiedPolicy("meeting_rooms")).toBe("rooms_in_use");
  });

  it("maps lights-off on an empty floor to the security level", () => {
    expect(policyForStrategies("open_plan", ["auto_lights_off"])).toBe("away");
  });

  it("prefers the policy that follows people when both are in effect", () => {
    expect(policyForStrategies("open_plan", ["auto_lights_off", "occupancy_gated_workday"])).toBe(
      "occupied_rows",
    );
  });

  it("matches nothing without a control strategy", () => {
    expect(policyForStrategies("open_plan", [])).toBeNull();
    expect(policyForStrategies("open_plan", ["investigate_on_site"])).toBeNull();
  });
});
