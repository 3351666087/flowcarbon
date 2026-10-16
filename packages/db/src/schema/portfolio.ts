import type { RuleParams, Tariff } from "@flowcarbon/core";
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
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { dayKindEnum } from "./enums";
import { organizations } from "./identity";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const buildings = pgTable(
  "buildings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    address: text("address"),
    timezone: text("timezone").notNull(),
    currency: text("currency").notNull().default("CNY"),
    workdayStart: text("workday_start").notNull().default("08:00"),
    afterHoursStart: text("after_hours_start").notNull().default("18:00"),
    gridRegion: text("grid_region").notNull(),
    tariff: jsonb("tariff").$type<Tariff>().notNull(),
    /** per-building overrides of the rule thresholds; every override is audited */
    ruleParams: jsonb("rule_params").$type<Partial<RuleParams>>().notNull().default({}),
    bucketMinutes: integer("bucket_minutes").notNull().default(15),
    archivedAt: ts("archived_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("buildings_org_idx").on(t.orgId)],
);

export const floors = pgTable(
  "floors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id")
      .notNull()
      .references(() => buildings.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    level: integer("level").notNull(),
    areaM2: doublePrecision("area_m2").notNull(),
    ratedHvacKw: doublePrecision("rated_hvac_kw").notNull(),
    ratedLightingKw: doublePrecision("rated_lighting_kw").notNull(),
    plugKwPerPerson: doublePrecision("plug_kw_per_person").notNull().default(0.12),
    zoneOnlyFraction: doublePrecision("zone_only_fraction").notNull().default(0.3),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("floors_building_label_uq").on(t.buildingId, t.label), index("floors_org_idx").on(t.orgId)],
);

/** Companies occupying floors (not to be confused with the SaaS organisation, which is the customer). */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id")
      .notNull()
      .references(() => buildings.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    overtimeRatePerHour: numeric("overtime_rate_per_hour", {
      precision: 12,
      scale: 2,
      mode: "number",
    }).notNull(),
    contactEmail: text("contact_email"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("tenants_building_idx").on(t.buildingId)],
);

export const leases = pgTable(
  "leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    floorId: uuid("floor_id")
      .notNull()
      .references(() => floors.id, { onDelete: "cascade" }),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on"),
  },
  (t) => [index("leases_floor_idx").on(t.floorId), index("leases_tenant_idx").on(t.tenantId)],
);

/** Public holidays and make-up working days per building. */
export const calendarDays = pgTable(
  "calendar_days",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id")
      .notNull()
      .references(() => buildings.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    kind: dayKindEnum("kind").notNull(),
    name: text("name"),
  },
  (t) => [primaryKey({ columns: [t.buildingId, t.day] })],
);
