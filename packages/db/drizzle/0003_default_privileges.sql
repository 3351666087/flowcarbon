-- Tables and sequences created by later migrations are granted to the runtime role automatically.
-- Default privileges attach to the role that runs this statement, i.e. the migration owner.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcarbon_app') THEN
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flowcarbon_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO flowcarbon_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flowcarbon_app;
    REVOKE UPDATE, DELETE ON audit_log FROM flowcarbon_app;
  END IF;
END $$;
