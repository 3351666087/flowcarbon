import type { FloorProfile } from "./model";
import { DEFAULT_RULE_PARAMS } from "./rules";

/**
 * A simulated floor: where its lights, fan coils and desks are, and what a control policy would leave on. Geometry and
 * power come from the floor's own area and rated power. It assumes controls can switch equipment directly, and nothing
 * in it is a measurement.
 */
export type TwinTemplate = "open_plan" | "meeting_rooms";
export type TwinPolicy = "all_on" | "occupied_rows" | "rooms_in_use" | "away";

/** A 2.75 m ceiling over a 0.75 m desk. */
export const DESK_TO_CEILING_M = 2;
/**
 * Between rows of lights and between the lights of a row: one fitting per 5.76 m², about what 8 W/m² buys in 46 W
 * panels. Rows are fitted to the floor, so the real spacing is near this and not exactly it.
 */
export const ROW_SPACING_M = 2.4;
/** Corridors are lit more thinly than rooms. */
const CORRIDOR_LIGHT_SPACING_M = 4.8;
/** The footprint is not stored, so floors are taken as a rectangle of this length to depth. */
const FOOTPRINT_ASPECT = 1.5;
/** One fan coil to about this much open floor. */
const FAN_COIL_M2 = 100;
const ROOM_WIDTH_M = 6;
const ROOM_DEPTH_M = 5;
const CORRIDOR_WIDTH_M = 1.8;
const SEAT_PITCH_M = 1.2;
const SEATS_FROM_TABLE_M = 0.8;
/** A floor larger than this is drawn as this much floor: more than any real floor plate, and still quick to draw. */
const MAX_MODELLED_M2 = 6_000;

/** What a warm-side drift assumes: an unconditioned zone would settle this far above setpoint, this slowly. */
export const DRIFT = { settleC: 6, tauHours: 3 };

export interface TwinFixture {
  id: string;
  x: number;
  y: number;
  /** the row, room or corridor it is switched with */
  group: string;
  /** light reaches only what shares its space: rooms have walls, an open floor does not */
  space: string;
}

export interface TwinGroup {
  id: string;
  kind: "row" | "room" | "corridor";
  /** its number among groups of its kind, from 1 */
  index: number;
  x: number;
  y: number;
  width: number;
  depth: number;
}

/** The area one fan coil serves, with the unit at its centre. */
export interface TwinZone {
  id: string;
  x: number;
  y: number;
  width: number;
  depth: number;
}

export interface TwinSeat {
  id: string;
  x: number;
  y: number;
  group: string;
  zone: string;
  space: string;
  /** its number within its group, from 1 */
  index: number;
}

export interface TwinLayout {
  template: TwinTemplate;
  /** the area modelled, in m² */
  areaM2: number;
  width: number;
  depth: number;
  groups: TwinGroup[];
  fixtures: TwinFixture[];
  zones: TwinZone[];
  seats: TwinSeat[];
}

type Parts = Pick<TwinLayout, "groups" | "fixtures" | "zones" | "seats">;

/** Rows of lights run along the floor with a line of desks under each, so each desk has one row above it. */
function openPlan(width: number, depth: number): Parts {
  const rows = Math.max(1, Math.round(depth / ROW_SPACING_M));
  const perRow = Math.max(1, Math.round(width / ROW_SPACING_M));
  const rowGap = depth / rows;
  const pitch = width / perRow;
  const wanted = Math.max(1, Math.round((width * depth) / FAN_COIL_M2));
  const across = Math.max(1, Math.round(Math.sqrt(wanted * FOOTPRINT_ASPECT)));
  const down = Math.max(1, Math.round(wanted / across));
  const zoneWidth = width / across;
  const zoneDepth = depth / down;
  const zoneOf = (x: number, y: number) =>
    `zone-${Math.min(across - 1, Math.floor(x / zoneWidth))}-${Math.min(down - 1, Math.floor(y / zoneDepth))}`;

  const parts: Parts = { groups: [], fixtures: [], zones: [], seats: [] };
  for (let r = 0; r < rows; r++) {
    const group = `row-${r + 1}`;
    const y = (r + 0.5) * rowGap;
    parts.groups.push({ id: group, kind: "row", index: r + 1, x: 0, y: r * rowGap, width, depth: rowGap });
    for (let c = 0; c < perRow; c++)
      parts.fixtures.push({ id: `${group}-${c + 1}`, x: (c + 0.5) * pitch, y, group, space: "floor" });
    // between the lights, so that a desk is not hidden behind its fitting on the plan
    const desks = Math.max(1, perRow - 1);
    for (let d = 0; d < desks; d++) {
      const x = perRow > 1 ? (d + 1) * pitch : width / 2;
      parts.seats.push({
        id: `${group}-desk-${d + 1}`,
        x,
        y,
        group,
        zone: zoneOf(x, y),
        space: "floor",
        index: d + 1,
      });
    }
  }
  for (let a = 0; a < across; a++)
    for (let b = 0; b < down; b++)
      parts.zones.push({
        id: `zone-${a}-${b}`,
        x: a * zoneWidth,
        y: b * zoneDepth,
        width: zoneWidth,
        depth: zoneDepth,
      });
  return parts;
}

/**
 * Rooms on both sides of a corridor, repeated across a deep floor. Each room has its own lights and fan coil and a
 * table with seats along both sides. Walls stop the light, so a room is lit by its own fittings alone.
 */
function meetingRooms(width: number, depth: number): Parts {
  const bands = Math.max(1, Math.round(depth / (2 * ROOM_DEPTH_M + CORRIDOR_WIDTH_M)));
  const band = depth / bands;
  const corridor = Math.min(CORRIDOR_WIDTH_M, band / 3);
  const roomDepth = (band - corridor) / 2;
  const perSide = Math.max(1, Math.round(width / ROOM_WIDTH_M));
  const roomWidth = width / perSide;
  const across = Math.max(1, Math.round(roomWidth / ROW_SPACING_M));
  const down = Math.max(1, Math.round(roomDepth / ROW_SPACING_M));
  const seatsPerSide = Math.max(1, Math.floor(roomWidth / SEAT_PITCH_M) - 1);
  const fromTable = Math.min(SEATS_FROM_TABLE_M, roomDepth / 4);

  const parts: Parts = { groups: [], fixtures: [], zones: [], seats: [] };
  const addRoom = (x: number, y: number) => {
    const index = parts.zones.length + 1;
    const id = `room-${index}`;
    parts.groups.push({ id, kind: "room", index, x, y, width: roomWidth, depth: roomDepth });
    parts.zones.push({ id, x, y, width: roomWidth, depth: roomDepth });
    for (let a = 0; a < across; a++)
      for (let d = 0; d < down; d++)
        parts.fixtures.push({
          id: `${id}-${a * down + d + 1}`,
          x: x + ((a + 0.5) * roomWidth) / across,
          y: y + ((d + 0.5) * roomDepth) / down,
          group: id,
          space: id,
        });
    for (const [side, offset] of [-fromTable, fromTable].entries())
      for (let s = 0; s < seatsPerSide; s++)
        parts.seats.push({
          id: `${id}-seat-${side * seatsPerSide + s + 1}`,
          x: x + (roomWidth * (s + 1)) / (seatsPerSide + 1),
          y: y + roomDepth / 2 + offset,
          group: id,
          zone: id,
          space: id,
          index: side * seatsPerSide + s + 1,
        });
  };
  const lights = Math.max(1, Math.round(width / CORRIDOR_LIGHT_SPACING_M));
  for (let b = 0; b < bands; b++) {
    const top = b * band;
    const id = `corridor-${b + 1}`;
    for (let r = 0; r < perSide; r++) addRoom(r * roomWidth, top);
    parts.groups.push({
      id,
      kind: "corridor",
      index: b + 1,
      x: 0,
      y: top + roomDepth,
      width,
      depth: corridor,
    });
    for (let l = 0; l < lights; l++)
      parts.fixtures.push({
        id: `${id}-${l + 1}`,
        x: ((l + 0.5) * width) / lights,
        y: top + roomDepth + corridor / 2,
        group: id,
        space: id,
      });
    for (let r = 0; r < perSide; r++) addRoom(r * roomWidth, top + roomDepth + corridor);
  }
  return parts;
}

/** The floor plan a template gives a floor of this area. */
export function twinLayout(areaM2: number, template: TwinTemplate): TwinLayout {
  const area = Math.min(areaM2, MAX_MODELLED_M2);
  const width = Math.sqrt(area * FOOTPRINT_ASPECT);
  const depth = area / width;
  const parts = template === "open_plan" ? openPlan(width, depth) : meetingRooms(width, depth);
  return { template, areaM2: area, width, depth, ...parts };
}

type DeskPoint = Pick<TwinSeat, "x" | "y" | "space">;

/**
 * Light falling on a desk from point sources of equal intensity in its space, `E = I · cos³θ / h²`, with I = 1: only
 * a ratio of two of these is ever shown.
 */
export function illuminance(at: DeskPoint, fixtures: readonly TwinFixture[]): number {
  const h = DESK_TO_CEILING_M;
  let e = 0;
  for (const f of fixtures) {
    if (f.space !== at.space) continue;
    const cos = h / Math.hypot(at.x - f.x, at.y - f.y, h);
    e += cos ** 3 / h ** 2;
  }
  return e;
}

/** How bright a desk is with these groups lit, as a share of the same desk with every light on. */
export function brightnessAt(
  at: DeskPoint,
  fixtures: readonly TwinFixture[],
  lit: ReadonlySet<string>,
): number {
  const full = illuminance(at, fixtures);
  if (full === 0) return 0;
  return (
    illuminance(
      at,
      fixtures.filter((f) => lit.has(f.group)),
    ) / full
  );
}

/** The policies that make sense on a template, in the order they are offered. */
export function twinPolicies(template: TwinTemplate): TwinPolicy[] {
  return ["all_on", occupiedPolicy(template), "away"];
}

/** The policy that follows the people on this template. */
export function occupiedPolicy(template: TwinTemplate): TwinPolicy {
  return template === "open_plan" ? "occupied_rows" : "rooms_in_use";
}

/** The policy that does on a floor what the strategies of the measures in effect there do. */
export function policyForStrategies(
  template: TwinTemplate,
  strategies: readonly string[],
): TwinPolicy | null {
  if (strategies.some((s) => s === "occupancy_gated_workday" || s === "zone_only_non_working"))
    return occupiedPolicy(template);
  return strategies.includes("auto_lights_off") ? "away" : null;
}

/** What stays lit with nobody expected: corridors, or evenly spaced rows up to the level a rule treats as security. */
function securityGroups(groups: readonly TwinGroup[]): string[] {
  const corridors = groups.filter((g) => g.kind === "corridor");
  if (corridors.length) return corridors.map((g) => g.id);
  const keep = Math.max(1, Math.floor(groups.length * DEFAULT_RULE_PARAMS.lightsMinLevel));
  return Array.from({ length: keep }, (_, i) => groups[Math.floor(((i + 0.5) * groups.length) / keep)]!.id);
}

function litGroups(layout: TwinLayout, policy: TwinPolicy, seated: readonly TwinSeat[]): Set<string> {
  if (policy === "all_on") return new Set(layout.groups.map((g) => g.id));
  if (policy === "away") return new Set(securityGroups(layout.groups));
  const lit = new Set(seated.map((s) => s.group));
  // a desk gets most of its light from the rows around it: its own row alone leaves it near 40 %, one either side 75 %
  if (policy === "occupied_rows") {
    const rows = layout.groups.filter((g) => g.kind === "row");
    for (const g of rows.filter((_, i) => lit.has(rows[i - 1]?.id ?? "") || lit.has(rows[i + 1]?.id ?? "")))
      lit.add(g.id);
  }
  // corridors stay lit with the rooms off: people still have to walk through, as "away" assumes too
  for (const g of layout.groups) if (g.kind === "corridor") lit.add(g.id);
  return lit;
}

export interface TwinPower {
  lightingKw: number;
  hvacKw: number;
  totalKw: number;
}

export interface SeatBrightness {
  seatId: string;
  brightness: number;
}

export interface TwinResult {
  policy: TwinPolicy;
  litGroups: string[];
  litFixtures: number;
  /** the zones whose fan coil runs */
  zonesOn: string[];
  fanCoilsOn: number;
  /** with everything on */
  before: TwinPower;
  after: TwinPower;
  /** at each seated person */
  seats: SeatBrightness[];
  worstSeat: SeatBrightness | null;
}

type TwinFloor = Pick<FloorProfile, "ratedLightingKw" | "ratedHvacKw" | "zoneOnlyFraction">;

/**
 * Each light draws its share of the floor's rated lighting and each fan coil its share of the rated cooling. The plant
 * behind them does not turn down without limit: while any fan coil runs, cooling stays at the floor's zone-only share.
 */
function power(floor: TwinFloor, layout: TwinLayout, litFixtures: number, fanCoilsOn: number): TwinPower {
  const lightingKw = (floor.ratedLightingKw * litFixtures) / layout.fixtures.length;
  const running = fanCoilsOn / layout.zones.length;
  const hvacKw = fanCoilsOn ? floor.ratedHvacKw * Math.max(running, floor.zoneOnlyFraction ?? 0.3) : 0;
  return { lightingKw, hvacKw, totalKw: lightingKw + hvacKw };
}

/**
 * What a policy leaves on for these people. Fan coils run only in zones with someone in them, whatever the lights do;
 * "all on" is the state everything is compared with. `people` are seat ids; one the layout does not have is ignored.
 */
export function evaluateTwin(
  floor: TwinFloor,
  layout: TwinLayout,
  policy: TwinPolicy,
  people: readonly string[],
): TwinResult {
  const wanted = new Set(people);
  const seated = layout.seats.filter((s) => wanted.has(s.id));
  const groups = litGroups(layout, policy, seated);
  const litFixtures = layout.fixtures.filter((f) => groups.has(f.group)).length;
  const zones =
    policy === "all_on" ? new Set(layout.zones.map((z) => z.id)) : new Set(seated.map((s) => s.zone));
  const seats = seated.map((s) => ({
    seatId: s.id,
    brightness: brightnessAt(s, layout.fixtures, groups),
  }));
  return {
    policy,
    litGroups: [...groups],
    litFixtures,
    zonesOn: [...zones],
    fanCoilsOn: zones.size,
    before: power(floor, layout, layout.fixtures.length, layout.zones.length),
    after: power(floor, layout, litFixtures, zones.size),
    seats,
    worstSeat: seats.reduce<SeatBrightness | null>(
      (worst, s) => (!worst || s.brightness < worst.brightness ? s : worst),
      null,
    ),
  };
}

/** How far an empty zone has drifted above setpoint this many hours after its fan coil stopped: a first-order estimate. */
export function driftC(hours: number, drift: typeof DRIFT = DRIFT): number {
  return drift.settleC * (1 - Math.exp(-hours / drift.tauHours));
}

/** FNV-1a, to turn a floor id into a seed. */
function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

/** mulberry32: small, and the same on every machine. */
function randomFrom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Every seat of the layout in the order a floor fills up: shuffled, always the same way for the same floor. */
export function seatOrder(layout: TwinLayout, floorId: string): string[] {
  const order = layout.seats.map((s) => s.id);
  const random = randomFrom(seedOf(floorId));
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/** Where this many people sit on a floor. As the count rises, those already seated stay where they are. */
export function placePeople(layout: TwinLayout, count: number, floorId: string): string[] {
  return seatOrder(layout, floorId).slice(0, Math.max(0, count));
}
