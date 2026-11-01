CREATE TYPE "public"."community_option_kind" AS ENUM('weekends', 'weekdays', 'balanced', 'custom');--> statement-breakpoint
CREATE TABLE "assistant_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"building_id" uuid NOT NULL,
	"requested_by" uuid,
	"locale" text DEFAULT 'en' NOT NULL,
	"prompt" text NOT NULL,
	"status" "ai_status" DEFAULT 'pending' NOT NULL,
	"intent" jsonb,
	"plan" jsonb,
	"reply" jsonb,
	"draft" text,
	"error" text,
	"model" text,
	"prompt_version" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"applied_option" text,
	"applied_at" timestamp with time zone,
	"applied_by" uuid,
	"applied_measures" jsonb
);
--> statement-breakpoint
CREATE TABLE "community_strategies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"building_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"option_kind" "community_option_kind" NOT NULL,
	"strategy_mix" jsonb NOT NULL,
	"floors_count" integer NOT NULL,
	"area_band" text NOT NULL,
	"result" jsonb NOT NULL,
	"published_by" uuid,
	"uses" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ai_briefs" ADD COLUMN "locale" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_explanations" ADD COLUMN "locale" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "floors" ADD COLUMN "layout" text DEFAULT 'open_plan' NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_applied_by_users_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_strategies" ADD CONSTRAINT "community_strategies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_strategies" ADD CONSTRAINT "community_strategies_building_id_buildings_id_fk" FOREIGN KEY ("building_id") REFERENCES "public"."buildings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_strategies" ADD CONSTRAINT "community_strategies_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_turns_building_idx" ON "assistant_turns" USING btree ("building_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "community_strategies_seeded_uq" ON "community_strategies" USING btree ("building_id","option_kind") WHERE "community_strategies"."org_id" is null;--> statement-breakpoint
CREATE INDEX "ai_briefs_building_locale_idx" ON "ai_briefs" USING btree ("building_id","locale","created_at");--> statement-breakpoint
CREATE INDEX "ai_finding_locale_idx" ON "ai_explanations" USING btree ("finding_id","locale","created_at");--> statement-breakpoint
ALTER TABLE "floors" ADD CONSTRAINT "floors_layout_check" CHECK ("floors"."layout" in ('open_plan', 'meeting_rooms'));--> statement-breakpoint
-- what is already stored was written in the language of whoever asked for it
UPDATE "ai_briefs" b SET "locale" = CASE WHEN u."locale" LIKE 'zh%' THEN 'zh' ELSE 'en' END FROM "users" u WHERE u."id" = b."requested_by";--> statement-breakpoint
UPDATE "ai_explanations" e SET "locale" = CASE WHEN u."locale" LIKE 'zh%' THEN 'zh' ELSE 'en' END FROM "users" u WHERE u."id" = e."requested_by";--> statement-breakpoint
-- turns belong to one organisation, like every other organisation-owned table (see 0001)
ALTER TABLE "assistant_turns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS org_isolation ON "assistant_turns";--> statement-breakpoint
CREATE POLICY org_isolation ON "assistant_turns" USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());--> statement-breakpoint
-- the one deliberate exception: published strategies are readable by every organisation until withdrawn, and writable
-- only by their own. FOR ALL, as for emission factors (see 0001), because a withdrawn row must stay visible to its
-- owner: an UPDATE has to pass the read policies with the new row too, or nobody could withdraw anything.
ALTER TABLE "community_strategies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS community_read ON "community_strategies";--> statement-breakpoint
CREATE POLICY community_read ON "community_strategies" FOR SELECT USING (withdrawn_at IS NULL);--> statement-breakpoint
DROP POLICY IF EXISTS community_write ON "community_strategies";--> statement-breakpoint
CREATE POLICY community_write ON "community_strategies" FOR ALL USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());--> statement-breakpoint
-- counting a use touches a row another organisation owns, which those policies refuse; this does that and nothing else
CREATE OR REPLACE FUNCTION community_strategy_used(strategy uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ UPDATE community_strategies SET uses = uses + 1 WHERE id = strategy AND withdrawn_at IS NULL $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION community_strategy_used(uuid) FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcarbon_app') THEN
    GRANT EXECUTE ON FUNCTION community_strategy_used(uuid) TO flowcarbon_app;
  END IF;
END $$;
