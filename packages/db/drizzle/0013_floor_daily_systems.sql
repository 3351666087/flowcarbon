ALTER TABLE "floor_daily" ADD COLUMN "kwh_hvac" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "floor_daily" ADD COLUMN "kwh_lighting" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "floor_daily" ADD COLUMN "kwh_plug" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Backfill the per-system split of every stored day from its 15-minute intervals, keyed by the building's local
-- date like the recompute path. Runs as the migration owner (RLS is enabled, not forced, on these tables). At
-- pilot scale one statement is fine; on a large floor_intervals hypertable run it per building, or let
-- reprocess-cli recompute the days, which writes these columns anyway.
UPDATE "floor_daily" d
SET "kwh_hvac" = s.h, "kwh_lighting" = s.l, "kwh_plug" = s.p
FROM (
  SELECT i."floor_id", (i."start_at" AT TIME ZONE b."timezone")::date AS day,
    sum(i."kwh_hvac") AS h, sum(i."kwh_lighting") AS l, sum(i."kwh_plug") AS p
  FROM "floor_intervals" i
  JOIN "buildings" b ON b."id" = i."building_id"
  GROUP BY 1, 2
) s
WHERE d."floor_id" = s."floor_id" AND d."day" = s.day;
