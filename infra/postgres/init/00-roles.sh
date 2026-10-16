#!/bin/sh
# Creates the runtime role used by the API and the worker: it owns no tables and cannot bypass row-level
# security. Migrations run as the database owner (POSTGRES_USER). Runs once, on an empty data directory.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="${APP_DB_PASSWORD:-flowcarbon-app-dev}" -v db="$POSTGRES_DB" <<'SQL'
SELECT format('CREATE ROLE flowcarbon_app LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowcarbon_app') \gexec
GRANT CONNECT ON DATABASE :"db" TO flowcarbon_app;
SQL
