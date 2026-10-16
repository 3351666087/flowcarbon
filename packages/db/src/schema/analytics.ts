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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  aiStatusEnum,
  dataTierEnum,
  dayTypeEnum,
  factorMethodEnum,
  factorStatusEnum,
  findingKindEnum,
  findingStatusEnum,
  hvacModeEnum,
  instrumentKindEnum,
  overtimeStatusEnum,
  scheduleAdviceEnum,
} from "./enums";
import { organizations, users } from "./identity";
import { buildings, floors, tenants } from "./portfolio";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const money = (name: string) => numeric(name, { precision: 14, scale: 2, mode: "number" });

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id")
      .notNull()
      .references(() => buildings.id, { onDelete: "cascade" }),
    floorId: uuid("floor_id")
      .notNull()
      .references(() => floors.id, { onDelete: "cascade" }),
    ruleId: text("rule_id").notNull(),
    kind: findingKindEnum("kind").notNull(),
    startAt: ts("start_at").notNull(),
    endAt: ts("end_at").notNull(),
    dayType: dayTypeEnum("day_type").notNull(),
    avoidableKwh: doublePrecision("avoidable_kwh").notNull(),
    avoidableCost: money("avoidable_cost").notNull(),
    avoidableCo2eKg: doublePrecision("avoidable_co2e_kg").notNull(),
    peakPeople: integer("peak_people").notNull(),
    tier: dataTierEnum("tier").notNull(),
    evidence: jsonb("evidence")
      .$type<{ summary: string; facts: Record<string, string | number> }>()
      .notNull(),
    /** rule parameters in force when the finding was produced */
    params: jsonb("params").$type<Record<string, unknown>>().notNull(),
    status: findingStatusEnum("status").notNull().default("open"),
    statusNote: text("status_note"),
    statusBy: uuid("status_by").references(() => users.id, { onDelete: "set null" }),
    statusAt: ts("status_at"),
    detectedAt: ts("detected_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("findings_fingerprint_uq").on(t.floorId, t.ruleId, t.startAt),
    index("findings_building_time_idx").on(t.buildingId, t.startAt),
    index("findings_status_idx").on(t.orgId, t.status),
  ],
);

export const aiExplanations = pgTable(
  "ai_explanations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    status: aiStatusEnum("status").notNull().default("pending"),
    model: text("model"),
    promptVersion: text("prompt_version").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    error: text("error"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
    completedAt: ts("completed_at"),
  },
  (t) => [index("ai_finding_idx").on(t.findingId, t.createdAt)],
);

export const forecasts = pgTable(
  "forecasts",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id")
      .notNull()
      .references(() => buildings.id, { onDelete: "cascade" }),
    floorId: uuid("floor_id")
      .notNull()
      .references(() => floors.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    dayType: dayTypeEnum("day_type").notNull(),
    median: integer("median").notNull(),
    low: integer("low").notNull(),
    high: integer("high").notNull(),
    basis: integer("basis").notNull(),
    advice: scheduleAdviceEnum("advice").notNull(),
    method: text("method").notNull(),
    generatedAt: ts("generated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.floorId, t.day] }),
    index("forecasts_building_day_idx").on(t.buildingId, t.day),
  ],
);

export const overtimeRequests = pgTable(
  "overtime_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id")
      .notNull()
      .references(() => buildings.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    floorId: uuid("floor_id")
      .notNull()
      .references(() => floors.id, { onDelete: "cascade" }),
    startAt: ts("start_at").notNull(),
    hours: doublePrecision("hours").notNull(),
    expectedPeople: integer("expected_people").notNull(),
    status: overtimeStatusEnum("status").notNull().default("requested"),
    recommendedMode: hvacModeEnum("recommended_mode").notNull(),
    approvedMode: hvacModeEnum("approved_mode"),
    fee: money("fee").notNull(),
    recommendation: text("recommendation").notNull(),
    decisionNote: text("decision_note"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: ts("decided_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("overtime_building_start_idx").on(t.buildingId, t.startAt),
    index("overtime_tenant_idx").on(t.tenantId),
  ],
);

/** Emission-factor library. Rows with a null org are the shared library; organisations can add their own. */
export const emissionFactors = pgTable(
  "emission_factors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "cascade" }),
    region: text("region").notNull(),
    year: integer("year").notNull(),
    method: factorMethodEnum("method").notNull(),
    kgPerKwh: doublePrecision("kg_per_kwh").notNull(),
    source: text("source").notNull(),
    status: factorStatusEnum("status").notNull().default("to_verify"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  // NULLS NOT DISTINCT so the shared library (org_id null) also has one row per region, year and method
  (t) => [unique("factor_scope_uq").on(t.orgId, t.region, t.year, t.method).nullsNotDistinct()],
);

export const contractualInstruments = pgTable(
  "contractual_instruments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id")
      .notNull()
      .references(() => buildings.id, { onDelete: "cascade" }),
    kind: instrumentKindEnum("kind").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    kwh: doublePrecision("kwh").notNull(),
    kgPerKwh: doublePrecision("kg_per_kwh").notNull().default(0),
    description: text("description"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("instruments_building_idx").on(t.buildingId, t.periodStart)],
);

/** A saved EPC / self-funded scenario (inputs only; results are recomputed). */
export const epcScenarios = pgTable(
  "epc_scenarios",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id")
      .notNull()
      .references(() => buildings.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    strategyId: text("strategy_id").notNull(),
    inputs: jsonb("inputs").$type<Record<string, number>>().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("scenarios_building_idx").on(t.buildingId)],
);

/** Frozen report: the numbers as they were signed off, for audit. */
export const reportSnapshots = pgTable(
  "report_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    buildingId: uuid("building_id")
      .notNull()
      .references(() => buildings.id, { onDelete: "cascade" }),
    periodFrom: ts("period_from").notNull(),
    periodTo: ts("period_to").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("reports_building_idx").on(t.buildingId, t.periodFrom)],
);
