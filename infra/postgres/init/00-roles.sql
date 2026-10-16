-- Application role used by the API and worker at runtime. It owns no tables and cannot bypass row-level
-- security; migrations run as the database owner.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcarbon_app') THEN
    CREATE ROLE flowcarbon_app LOGIN PASSWORD 'flowcarbon-app-dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT CONNECT ON DATABASE flowcarbon TO flowcarbon_app;
