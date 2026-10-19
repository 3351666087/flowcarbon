CREATE TABLE "ai_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"status" "ai_status" DEFAULT 'pending' NOT NULL,
	"model" text,
	"prompt_version" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"draft" text,
	"error" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"requested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ai_briefs" ADD CONSTRAINT "ai_briefs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_briefs" ADD CONSTRAINT "ai_briefs_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_briefs" ADD CONSTRAINT "ai_briefs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_briefs_building_idx" ON "ai_briefs" USING btree ("building_id","created_at");--> statement-breakpoint
-- briefs belong to one organisation, like every other organisation-owned table (see 0001)
ALTER TABLE "ai_briefs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON "ai_briefs";--> statement-breakpoint
CREATE POLICY org_isolation ON "ai_briefs" USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
