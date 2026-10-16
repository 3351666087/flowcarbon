-- Platform layer: TimescaleDB hypertables for telemetry, row-level security for tenant isolation,
-- and grants for the runtime application role. Idempotent where the database allows.

-- 1. Time series ---------------------------------------------------------------------------------
-- TimescaleDB is optional (tests can run on plain PostgreSQL); production images include it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    CREATE EXTENSION IF NOT EXISTS timescaledb;
    PERFORM create_hypertable('energy_readings', by_range('start_at', INTERVAL '7 days'), if_not_exists => TRUE, migrate_data => TRUE);
    PERFORM create_hypertable('door_counts', by_range('start_at', INTERVAL '7 days'), if_not_exists => TRUE, migrate_data => TRUE);
    PERFORM create_hypertable('hvac_events', by_range('at', INTERVAL '30 days'), if_not_exists => TRUE, migrate_data => TRUE);
    PERFORM create_hypertable('lighting_events', by_range('at', INTERVAL '30 days'), if_not_exists => TRUE, migrate_data => TRUE);
    PERFORM create_hypertable('floor_intervals', by_range('start_at', INTERVAL '30 days'), if_not_exists => TRUE, migrate_data => TRUE);
  END IF;
END $$;
--> statement-breakpoint

-- 2. Row-level security --------------------------------------------------------------------------
-- Every organisation-owned table only shows rows of the organisation set in `app.org_id` for the
-- current transaction. The table owner (used for migrations) is exempt; the application role is not.
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'buildings', 'floors', 'tenants', 'leases', 'calendar_days', 'devices', 'ingestion_batches',
    'findings', 'ai_explanations', 'forecasts', 'overtime_requests', 'contractual_instruments',
    'epc_scenarios', 'report_snapshots', 'audit_log', 'floor_daily',
    'hvac_events', 'lighting_events', 'floor_intervals'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY org_isolation ON %I USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org())', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- shared factor library rows (org_id IS NULL) are readable by everyone, writable by nobody at runtime
ALTER TABLE emission_factors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS factor_read ON emission_factors;
--> statement-breakpoint
CREATE POLICY factor_read ON emission_factors FOR SELECT USING (org_id IS NULL OR org_id = app_current_org());
--> statement-breakpoint
DROP POLICY IF EXISTS factor_write ON emission_factors;
--> statement-breakpoint
CREATE POLICY factor_write ON emission_factors FOR ALL USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint

-- 3. Compression ---------------------------------------------------------------------------------
-- TimescaleDB's columnstore cannot be combined with row-level security, so the two highest-volume raw
-- tables (energy_readings, door_counts) are compressed and NOT under RLS. They hold only numbers keyed by
-- device id; every read joins the RLS-protected `devices` table and every write is validated against it.
-- See docs/adr/0002-telemetry-isolation.md.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    ALTER TABLE energy_readings SET (timescaledb.compress, timescaledb.compress_segmentby = 'device_id', timescaledb.compress_orderby = 'start_at');
    ALTER TABLE door_counts SET (timescaledb.compress, timescaledb.compress_segmentby = 'device_id', timescaledb.compress_orderby = 'start_at');
    PERFORM add_compression_policy('energy_readings', INTERVAL '30 days', if_not_exists => TRUE);
    PERFORM add_compression_policy('door_counts', INTERVAL '30 days', if_not_exists => TRUE);
  END IF;
END $$;
--> statement-breakpoint

-- 4. Runtime role --------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcarbon_app') THEN
    GRANT USAGE ON SCHEMA public TO flowcarbon_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flowcarbon_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO flowcarbon_app;
    GRANT EXECUTE ON FUNCTION app_current_org() TO flowcarbon_app;
    -- the audit log is append-only for the application
    REVOKE UPDATE, DELETE ON audit_log FROM flowcarbon_app;
  END IF;
END $$;
