import { pgEnum } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("member_role", [
  "owner",
  "admin",
  "property_manager",
  "energy_analyst",
  "engineer",
  "tenant_admin",
  "viewer",
]);
export const actorTypeEnum = pgEnum("actor_type", ["user", "api_key", "system"]);
export const dayKindEnum = pgEnum("calendar_day_kind", ["holiday", "workday"]);
export const deviceKindEnum = pgEnum("device_kind", [
  "meter",
  "door_counter",
  "bms_zone",
  "lighting_controller",
]);
export const meterSystemEnum = pgEnum("meter_system", ["hvac", "lighting", "plug", "total"]);
export const hvacModeEnum = pgEnum("hvac_mode", ["off", "setback", "full"]);
export const dataTierEnum = pgEnum("data_tier", ["measured", "estimated"]);
export const findingKindEnum = pgEnum("finding_kind", ["waste", "opportunity"]);
export const findingStatusEnum = pgEnum("finding_status", ["open", "acknowledged", "fixed", "dismissed"]);
export const dayTypeEnum = pgEnum("day_type", ["workday", "weekend", "holiday"]);
export const overtimeStatusEnum = pgEnum("overtime_status", [
  "requested",
  "approved",
  "declined",
  "cancelled",
]);
export const scheduleAdviceEnum = pgEnum("schedule_advice", ["on_demand", "setback", "off"]);
export const factorMethodEnum = pgEnum("factor_method", ["location", "market"]);
export const factorStatusEnum = pgEnum("factor_status", ["verified", "to_verify"]);
export const instrumentKindEnum = pgEnum("instrument_kind", [
  "green_certificate",
  "ppa",
  "green_tariff",
  "onsite_renewable",
]);
export const aiStatusEnum = pgEnum("ai_status", ["pending", "done", "failed"]);
export const batchStatusEnum = pgEnum("ingest_status", ["accepted", "processed", "failed"]);
