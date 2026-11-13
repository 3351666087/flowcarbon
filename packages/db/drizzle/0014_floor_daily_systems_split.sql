ALTER TABLE "floor_daily" ADD COLUMN "systems_split" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Corrects the 0013 backfill and records where the per-system split is real. A day keeps systems_split = false
-- (its energy is reported as unsplit, never as the tenant's or the building's) unless its per-system kWh add
-- up to kwh_total. First, every day whose stored intervals still add up to its total gets its split from them
-- again: this repairs days written with zeros by a version that predates 0013 (for example a worker still
-- running while 0013 was applied). Days whose intervals are gone or incomplete are left as they are.
-- Runs as the migration owner (RLS is enabled, not forced). At pilot scale one statement is fine; on a large
-- floor_intervals hypertable run it per building, or let reprocess-cli recompute the days, which sets the split.
UPDATE "floor_daily" d
SET "kwh_hvac" = s.h, "kwh_lighting" = s.l, "kwh_plug" = s.p, "systems_split" = true
FROM (
  SELECT i."floor_id", (i."start_at" AT TIME ZONE b."timezone")::date AS day,
    sum(i."kwh_hvac") AS h, sum(i."kwh_lighting") AS l, sum(i."kwh_plug") AS p
  FROM "floor_intervals" i
  JOIN "buildings" b ON b."id" = i."building_id"
  GROUP BY 1, 2
) s
WHERE d."floor_id" = s."floor_id" AND d."day" = s.day
  AND abs(s.h + s.l + s.p - d."kwh_total") <= greatest(0.001, abs(d."kwh_total") * 1e-6);--> statement-breakpoint
-- Days without intervals whose stored split already adds up (including days with no energy at all).
UPDATE "floor_daily"
SET "systems_split" = true
WHERE NOT "systems_split"
  AND abs("kwh_hvac" + "kwh_lighting" + "kwh_plug" - "kwh_total") <= greatest(0.001, abs("kwh_total") * 1e-6);
