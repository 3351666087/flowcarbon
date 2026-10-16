import {
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  batchStatusEnum,
  dataTierEnum,
  dayTypeEnum,
  deviceKindEnum,
  hvacModeEnum,
  meterSystemEnum,
} from "./enums";
import { apiKeys, organizations } from "./identity";
import { buildings, floors } from "./portfolio";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** A physical or logical data source: a sub-meter, a door counter, a BMS zone, a lighting controller. */
export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id")
      .notNull()
      .references(() => buildings.id, { onDelete: "cascade" }),
    floorId: uuid("floor_id").references(() => floors.id, { onDelete: "set null" }),
    kind: deviceKindEnum("kind").notNull(),
    /** for meters: which system the meter measures */
    system: meterSystemEnum("system"),
    /** identifier used by the gateway; unique per organisation */
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastSeenAt: ts("last_seen_at"),
  },
  (t) => [
    uniqueIndex("devices_org_external_uq").on(t.orgId, t.externalId),
    index("devices_floor_idx").on(t.floorId),
  ],
);

// ---- raw time series (TimescaleDB hypertables, see migration 0001) ----

export const energyReadings = pgTable(
  "energy_readings",
  {
    orgId: uuid("org_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    startAt: ts("start_at").notNull(),
    endAt: ts("end_at").notNull(),
    kwh: doublePrecision("kwh").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.startAt] })],
);

export const doorCounts = pgTable(
  "door_counts",
  {
    orgId: uuid("org_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    floorId: uuid("floor_id").notNull(),
    startAt: ts("start_at").notNull(),
    entries: integer("entries").notNull(),
    exits: integer("exits").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.startAt] }),
    index("door_counts_floor_time_idx").on(t.floorId, t.startAt),
  ],
);

export const hvacEvents = pgTable(
  "hvac_events",
  {
    orgId: uuid("org_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    floorId: uuid("floor_id").notNull(),
    at: ts("at").notNull(),
    mode: hvacModeEnum("mode").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.at] }),
    index("hvac_events_floor_time_idx").on(t.floorId, t.at),
  ],
);

export const lightingEvents = pgTable(
  "lighting_events",
  {
    orgId: uuid("org_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    floorId: uuid("floor_id").notNull(),
    at: ts("at").notNull(),
    level: doublePrecision("level").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.deviceId, t.at] }),
    index("lighting_events_floor_time_idx").on(t.floorId, t.at),
  ],
);

/** Derived 15-min floor intervals; recomputed idempotently by the worker. */
export const floorIntervals = pgTable(
  "floor_intervals",
  {
    orgId: uuid("org_id").notNull(),
    buildingId: uuid("building_id").notNull(),
    floorId: uuid("floor_id").notNull(),
    startAt: ts("start_at").notNull(),
    minutes: integer("minutes").notNull(),
    occupancy: integer("occupancy").notNull(),
    hvacOn: doublePrecision("hvac_on").notNull(),
    hvacMode: hvacModeEnum("hvac_mode").notNull(),
    lightsOn: doublePrecision("lights_on").notNull(),
    kwhHvac: doublePrecision("kwh_hvac").notNull(),
    kwhLighting: doublePrecision("kwh_lighting").notNull(),
    kwhPlug: doublePrecision("kwh_plug").notNull(),
    tier: dataTierEnum("tier").notNull(),
    computedAt: ts("computed_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.floorId, t.startAt] }),
    index("floor_intervals_building_time_idx").on(t.buildingId, t.startAt),
  ],
);

/** One ingestion request; the idempotency key makes gateway retries safe. */
export const ingestionBatches = pgTable(
  "ingestion_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id")
      .notNull()
      .references(() => buildings.id, { onDelete: "cascade" }),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").notNull(),
    counts: jsonb("counts").$type<Record<string, number>>().notNull(),
    rangeFrom: ts("range_from"),
    rangeTo: ts("range_to"),
    status: batchStatusEnum("status").notNull().default("accepted"),
    error: text("error"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
  },
  (t) => [
    uniqueIndex("ingestion_org_idem_uq").on(t.orgId, t.idempotencyKey),
    index("ingestion_building_idx").on(t.buildingId, t.receivedAt),
  ],
);

/**
 * Daily roll-up per floor and local date, maintained by the pipeline. Reports, trends and forecasts read
 * this table instead of scanning intervals, so their cost does not grow with telemetry volume.
 */
export const floorDaily = pgTable(
  "floor_daily",
  {
    orgId: uuid("org_id").notNull(),
    buildingId: uuid("building_id").notNull(),
    floorId: uuid("floor_id").notNull(),
    day: date("day").notNull(),
    dayType: dayTypeEnum("day_type").notNull(),
    kwhTotal: doublePrecision("kwh_total").notNull(),
    kwhAfterHours: doublePrecision("kwh_after_hours").notNull(),
    kwhMeasured: doublePrecision("kwh_measured").notNull(),
    cost: numeric("cost", { precision: 14, scale: 2, mode: "number" }).notNull(),
    afterHoursPeak: integer("after_hours_peak").notNull(),
    afterHoursHvacHours: doublePrecision("after_hours_hvac_hours").notNull(),
    avoidableKwh: doublePrecision("avoidable_kwh").notNull().default(0),
    intervals: integer("intervals").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.floorId, t.day] }),
    index("floor_daily_building_day_idx").on(t.buildingId, t.day),
  ],
);
