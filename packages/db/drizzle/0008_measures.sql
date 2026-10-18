CREATE TYPE "public"."measure_source" AS ENUM('ai', 'ai_edited', 'manual');--> statement-breakpoint
CREATE TYPE "public"."measure_status" AS ENUM('planned', 'in_effect', 'cancelled');--> statement-breakpoint
CREATE TABLE "measures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"floor_id" uuid NOT NULL,
	"strategy_id" text NOT NULL,
	"note" text,
	"source" "measure_source" NOT NULL,
	"explanation_id" uuid,
	"origin_finding_id" uuid,
	"origin_rule_id" text NOT NULL,
	"status" "measure_status" DEFAULT 'planned' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"implemented_by" uuid,
	"implemented_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "measure_id" uuid;--> statement-breakpoint
ALTER TABLE "measures" ADD CONSTRAINT "measures_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measures" ADD CONSTRAINT "measures_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measures" ADD CONSTRAINT "measures_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measures" ADD CONSTRAINT "measures_explanation_id_ai_explanations_id_fk" FOREIGN KEY ("explanation_id") REFERENCES "public"."ai_explanations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measures" ADD CONSTRAINT "measures_origin_finding_id_findings_id_fk" FOREIGN KEY ("origin_finding_id") REFERENCES "public"."findings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measures" ADD CONSTRAINT "measures_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measures" ADD CONSTRAINT "measures_implemented_by_users_id_fk" FOREIGN KEY ("implemented_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measures" ADD CONSTRAINT "measures_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "measures_building_status_idx" ON "measures" USING btree ("building_id","status");--> statement-breakpoint
CREATE INDEX "measures_floor_idx" ON "measures" USING btree ("floor_id");--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_measure_id_measures_id_fk" FOREIGN KEY ("measure_id") REFERENCES "public"."measures"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "findings_measure_idx" ON "findings" USING btree ("measure_id");--> statement-breakpoint
-- measures belong to one organisation, like every other organisation-owned table (see 0001)
ALTER TABLE "measures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON "measures";--> statement-breakpoint
CREATE POLICY org_isolation ON "measures" USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
