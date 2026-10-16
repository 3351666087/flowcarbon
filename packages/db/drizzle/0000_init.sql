CREATE TYPE "public"."actor_type" AS ENUM('user', 'api_key', 'system');--> statement-breakpoint
CREATE TYPE "public"."ai_status" AS ENUM('pending', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ingest_status" AS ENUM('accepted', 'processed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."data_tier" AS ENUM('measured', 'estimated');--> statement-breakpoint
CREATE TYPE "public"."calendar_day_kind" AS ENUM('holiday', 'workday');--> statement-breakpoint
CREATE TYPE "public"."day_type" AS ENUM('workday', 'weekend', 'holiday');--> statement-breakpoint
CREATE TYPE "public"."device_kind" AS ENUM('meter', 'door_counter', 'bms_zone', 'lighting_controller');--> statement-breakpoint
CREATE TYPE "public"."factor_method" AS ENUM('location', 'market');--> statement-breakpoint
CREATE TYPE "public"."factor_status" AS ENUM('verified', 'to_verify');--> statement-breakpoint
CREATE TYPE "public"."finding_kind" AS ENUM('waste', 'opportunity');--> statement-breakpoint
CREATE TYPE "public"."finding_status" AS ENUM('open', 'acknowledged', 'fixed', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."hvac_mode" AS ENUM('off', 'setback', 'full');--> statement-breakpoint
CREATE TYPE "public"."instrument_kind" AS ENUM('green_certificate', 'ppa', 'green_tariff', 'onsite_renewable');--> statement-breakpoint
CREATE TYPE "public"."meter_system" AS ENUM('hvac', 'lighting', 'plug', 'total');--> statement-breakpoint
CREATE TYPE "public"."overtime_status" AS ENUM('requested', 'approved', 'declined', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'property_manager', 'energy_analyst', 'engineer', 'tenant_admin', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."schedule_advice" AS ENUM('on_demand', 'setback', 'off');--> statement-breakpoint
CREATE TABLE "ai_explanations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"finding_id" uuid NOT NULL,
	"status" "ai_status" DEFAULT 'pending' NOT NULL,
	"model" text,
	"prompt_version" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"error" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contractual_instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"kind" "instrument_kind" NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"kwh" double precision NOT NULL,
	"kg_per_kwh" double precision DEFAULT 0 NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emission_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"region" text NOT NULL,
	"year" integer NOT NULL,
	"method" "factor_method" NOT NULL,
	"kg_per_kwh" double precision NOT NULL,
	"source" text NOT NULL,
	"status" "factor_status" DEFAULT 'to_verify' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "epc_scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"name" text NOT NULL,
	"strategy_id" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"floor_id" uuid NOT NULL,
	"rule_id" text NOT NULL,
	"kind" "finding_kind" NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"day_type" "day_type" NOT NULL,
	"avoidable_kwh" double precision NOT NULL,
	"avoidable_cost" numeric(14, 2) NOT NULL,
	"avoidable_co2e_kg" double precision NOT NULL,
	"peak_people" integer NOT NULL,
	"tier" "data_tier" NOT NULL,
	"evidence" jsonb NOT NULL,
	"params" jsonb NOT NULL,
	"status" "finding_status" DEFAULT 'open' NOT NULL,
	"status_note" text,
	"status_by" uuid,
	"status_at" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forecasts" (
	"org_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"floor_id" uuid NOT NULL,
	"day" date NOT NULL,
	"day_type" "day_type" NOT NULL,
	"median" integer NOT NULL,
	"low" integer NOT NULL,
	"high" integer NOT NULL,
	"basis" integer NOT NULL,
	"advice" "schedule_advice" NOT NULL,
	"method" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forecasts_floor_id_day_pk" PRIMARY KEY("floor_id","day")
);
--> statement-breakpoint
CREATE TABLE "overtime_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"floor_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"hours" double precision NOT NULL,
	"expected_people" integer NOT NULL,
	"status" "overtime_status" DEFAULT 'requested' NOT NULL,
	"recommended_mode" "hvac_mode" NOT NULL,
	"approved_mode" "hvac_mode",
	"fee" numeric(14, 2) NOT NULL,
	"recommendation" text NOT NULL,
	"decision_note" text,
	"requested_by" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"period_from" timestamp with time zone NOT NULL,
	"period_to" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"building_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"data" jsonb,
	"ip" "inet",
	"request_id" text,
	"success" boolean DEFAULT true NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "member_role" NOT NULL,
	"tenant_id" uuid,
	"token_hash" text NOT NULL,
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" NOT NULL,
	"tenant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"plan" text DEFAULT 'standard' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" "inet",
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "buildings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"timezone" text NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"workday_start" text DEFAULT '08:00' NOT NULL,
	"after_hours_start" text DEFAULT '18:00' NOT NULL,
	"grid_region" text NOT NULL,
	"tariff" jsonb NOT NULL,
	"rule_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bucket_minutes" integer DEFAULT 15 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_days" (
	"org_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"day" date NOT NULL,
	"kind" "calendar_day_kind" NOT NULL,
	"name" text,
	CONSTRAINT "calendar_days_building_id_day_pk" PRIMARY KEY("building_id","day")
);
--> statement-breakpoint
CREATE TABLE "floors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"label" text NOT NULL,
	"level" integer NOT NULL,
	"area_m2" double precision NOT NULL,
	"rated_hvac_kw" double precision NOT NULL,
	"rated_lighting_kw" double precision NOT NULL,
	"plug_kw_per_person" double precision DEFAULT 0.12 NOT NULL,
	"zone_only_fraction" double precision DEFAULT 0.3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "floors_building_label_uq" UNIQUE("building_id","label")
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"floor_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"name" text NOT NULL,
	"overtime_rate_per_hour" numeric(12, 2) NOT NULL,
	"contact_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"floor_id" uuid,
	"kind" "device_kind" NOT NULL,
	"system" "meter_system",
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "door_counts" (
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"floor_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"entries" integer NOT NULL,
	"exits" integer NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "door_counts_device_id_start_at_pk" PRIMARY KEY("device_id","start_at")
);
--> statement-breakpoint
CREATE TABLE "energy_readings" (
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"kwh" double precision NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "energy_readings_device_id_start_at_pk" PRIMARY KEY("device_id","start_at")
);
--> statement-breakpoint
CREATE TABLE "floor_daily" (
	"org_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"floor_id" uuid NOT NULL,
	"day" date NOT NULL,
	"day_type" "day_type" NOT NULL,
	"kwh_total" double precision NOT NULL,
	"kwh_after_hours" double precision NOT NULL,
	"kwh_measured" double precision NOT NULL,
	"cost" numeric(14, 2) NOT NULL,
	"after_hours_peak" integer NOT NULL,
	"after_hours_hvac_hours" double precision NOT NULL,
	"avoidable_kwh" double precision DEFAULT 0 NOT NULL,
	"intervals" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "floor_daily_floor_id_day_pk" PRIMARY KEY("floor_id","day")
);
--> statement-breakpoint
CREATE TABLE "floor_intervals" (
	"org_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"floor_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"minutes" integer NOT NULL,
	"occupancy" integer NOT NULL,
	"hvac_on" double precision NOT NULL,
	"hvac_mode" "hvac_mode" NOT NULL,
	"lights_on" double precision NOT NULL,
	"kwh_hvac" double precision NOT NULL,
	"kwh_lighting" double precision NOT NULL,
	"kwh_plug" double precision NOT NULL,
	"tier" "data_tier" NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "floor_intervals_floor_id_start_at_pk" PRIMARY KEY("floor_id","start_at")
);
--> statement-breakpoint
CREATE TABLE "hvac_events" (
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"floor_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"mode" "hvac_mode" NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hvac_events_device_id_at_pk" PRIMARY KEY("device_id","at")
);
--> statement-breakpoint
CREATE TABLE "ingestion_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"api_key_id" uuid,
	"idempotency_key" text NOT NULL,
	"counts" jsonb NOT NULL,
	"range_from" timestamp with time zone,
	"range_to" timestamp with time zone,
	"status" "ingest_status" DEFAULT 'accepted' NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lighting_events" (
	"org_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"floor_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"level" double precision NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lighting_events_device_id_at_pk" PRIMARY KEY("device_id","at")
);
--> statement-breakpoint
ALTER TABLE "ai_explanations" ADD CONSTRAINT "ai_explanations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_explanations" ADD CONSTRAINT "ai_explanations_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_explanations" ADD CONSTRAINT "ai_explanations_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contractual_instruments" ADD CONSTRAINT "contractual_instruments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contractual_instruments" ADD CONSTRAINT "contractual_instruments_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emission_factors" ADD CONSTRAINT "emission_factors_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epc_scenarios" ADD CONSTRAINT "epc_scenarios_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epc_scenarios" ADD CONSTRAINT "epc_scenarios_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epc_scenarios" ADD CONSTRAINT "epc_scenarios_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_status_by_users_id_fk" FOREIGN KEY ("status_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecasts" ADD CONSTRAINT "forecasts_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_requests" ADD CONSTRAINT "overtime_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buildings" ADD CONSTRAINT "buildings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_days" ADD CONSTRAINT "calendar_days_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_days" ADD CONSTRAINT "calendar_days_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "floors" ADD CONSTRAINT "floors_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "floors" ADD CONSTRAINT "floors_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_batches" ADD CONSTRAINT "ingestion_batches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_batches" ADD CONSTRAINT "ingestion_batches_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_batches" ADD CONSTRAINT "ingestion_batches_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_finding_idx" ON "ai_explanations" USING btree ("finding_id","created_at");--> statement-breakpoint
CREATE INDEX "instruments_building_idx" ON "contractual_instruments" USING btree ("building_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "factor_scope_uq" ON "emission_factors" USING btree ("org_id","region","year","method");--> statement-breakpoint
CREATE INDEX "scenarios_building_idx" ON "epc_scenarios" USING btree ("building_id");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_fingerprint_uq" ON "findings" USING btree ("floor_id","rule_id","start_at");--> statement-breakpoint
CREATE INDEX "findings_building_time_idx" ON "findings" USING btree ("building_id","start_at");--> statement-breakpoint
CREATE INDEX "findings_status_idx" ON "findings" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "forecasts_building_day_idx" ON "forecasts" USING btree ("building_id","day");--> statement-breakpoint
CREATE INDEX "overtime_building_start_idx" ON "overtime_requests" USING btree ("building_id","start_at");--> statement-breakpoint
CREATE INDEX "overtime_tenant_idx" ON "overtime_requests" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "reports_building_idx" ON "report_snapshots" USING btree ("building_id","period_from");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "audit_org_at_idx" ON "audit_log" USING btree ("org_id","at");--> statement-breakpoint
CREATE INDEX "invitations_org_idx" ON "invitations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "buildings_org_idx" ON "buildings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "floors_org_idx" ON "floors" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "leases_floor_idx" ON "leases" USING btree ("floor_id");--> statement-breakpoint
CREATE INDEX "leases_tenant_idx" ON "leases" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenants_building_idx" ON "tenants" USING btree ("building_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_org_external_uq" ON "devices" USING btree ("org_id","external_id");--> statement-breakpoint
CREATE INDEX "devices_floor_idx" ON "devices" USING btree ("floor_id");--> statement-breakpoint
CREATE INDEX "door_counts_floor_time_idx" ON "door_counts" USING btree ("floor_id","start_at");--> statement-breakpoint
CREATE INDEX "floor_daily_building_day_idx" ON "floor_daily" USING btree ("building_id","day");--> statement-breakpoint
CREATE INDEX "floor_intervals_building_time_idx" ON "floor_intervals" USING btree ("building_id","start_at");--> statement-breakpoint
CREATE INDEX "hvac_events_floor_time_idx" ON "hvac_events" USING btree ("floor_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_org_idem_uq" ON "ingestion_batches" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "ingestion_building_idx" ON "ingestion_batches" USING btree ("building_id","received_at");--> statement-breakpoint
CREATE INDEX "lighting_events_floor_time_idx" ON "lighting_events" USING btree ("floor_id","at");