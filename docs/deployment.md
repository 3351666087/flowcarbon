# Deployment

FlowCarbon ships as two images built from the repository's `Dockerfile`:

| Image | Runs | Command |
|---|---|---|
| `ghcr.io/3351666087/flowcarbon-server` | API (port 4000), worker (health/metrics on 4100), migrations, demo seed and pump | `node api.mjs`, `node worker.mjs`, `node migrate.mjs`, `node seed.mjs`, `node pump.mjs` |
| `ghcr.io/3351666087/flowcarbon-web` | Web application (port 3000) | default |

Both run as the unprivileged `node` user, carry a health check, and contain production dependencies only.

## Single host with Docker Compose

```bash
cp .env.example infra/.env        # then edit the passwords and PUBLIC_URL
docker compose -f infra/docker-compose.yml --profile app up -d --build
DEMO_PASSWORD='choose-one' docker compose -f infra/docker-compose.yml --profile demo run --rm seed   # optional
```

Order of start-up: `db` → `migrate` (one-shot, owner role) → `api` and `worker` (runtime role) → `web`.

Published ports (database 5432, API 4000, web 3000) bind to `127.0.0.1` unless `DB_BIND`, `API_BIND` or `WEB_BIND`
says otherwise; Docker publishes ports past host firewalls, so keep them local and let a proxy face the internet.
Each service has a memory cap (`DB_MEM_LIMIT`, `API_MEM_LIMIT`, `WORKER_MEM_LIMIT`, `WEB_MEM_LIMIT`) and PostgreSQL
takes `PG_SHARED_BUFFERS` and `PG_EFFECTIVE_CACHE_SIZE`; the defaults suit a 4 GB host shared with nothing else.

### HTTPS on a single host

The `edge` profile adds Caddy, which obtains and renews a certificate for `DOMAIN` and serves the API under
`/api/v1` and the web app under one origin. Point the host name's DNS record at the server and open ports 80 and 443.

```bash
# infra/.env: DOMAIN=fc.example.org, PUBLIC_URL=https://fc.example.org, COOKIE_SECURE=true
docker compose -f infra/docker-compose.yml --profile app --profile edge up -d
```

### Live demo data

`seed` creates the simulated tower for the last 28 days. The `pump` profile keeps it live: every
`PUMP_INTERVAL_MINUTES` (15) it simulates the elapsed part of the day, writes it through the same ingestion function
the telemetry API uses, records the simulated tenants' overtime requests and recomputes intervals, findings and
forecasts. It only continues days it started itself, so the seeded history is never rewritten.

```bash
docker compose -f infra/docker-compose.yml --profile pump up -d pump
```

## Database

- PostgreSQL 17 with TimescaleDB 2.30 (`timescale/timescaledb:2.30.2-pg17`). Plain PostgreSQL works without
  hypertables and compression.
- Two roles. The **owner** (`DATABASE_MIGRATION_URL`) runs migrations, reference data and the job-queue schema and
  is used by nothing else. The **runtime role** `flowcarbon_app` (`DATABASE_URL`) is `NOSUPERUSER NOBYPASSRLS`;
  `infra/postgres/init/00-roles.sh` creates it with `APP_DB_PASSWORD`. On a managed database, create it by hand:

  ```sql
  CREATE ROLE flowcarbon_app LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS;
  GRANT CONNECT ON DATABASE flowcarbon TO flowcarbon_app;
  ```
- Run `node migrate.mjs` on every deploy before starting the new API and worker. It is idempotent.
- Back up with `pg_dump` or the provider's snapshots; TimescaleDB compression is transparent to both.

## Web and API behind one origin

The browser talks to the API through the web origin (`/api/v1/*`), so the session cookie is first-party. The web
image forwards `/api/v1` to `API_ORIGIN`, fixed at build time (`--build-arg API_ORIGIN=http://api:4000`). Behind an
ingress or load balancer, route `/api/v1/` straight to the API service and everything else to the web service.

Behind TLS set `COOKIE_SECURE=true` (the cookie becomes `__Host-fc_session`) and `TRUST_PROXY=true`, and set
`PUBLIC_URL`/`CORS_ORIGINS` to the public origin. Cookie-authenticated writes are refused unless their `Origin` is
in `CORS_ORIGINS`.

## Configuration

| Variable | Service | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | api, worker | — | runtime role |
| `DATABASE_MIGRATION_URL` | migrate | — | owner role |
| `CORS_ORIGINS`, `APP_URL` | api | `http://localhost:3000` | public web origin; invitation links use `APP_URL` |
| `COOKIE_SECURE` | api | `true` in production | |
| `SESSION_IDLE_HOURS`, `SESSION_MAX_DAYS` | api | 12, 7 | sliding sessions with an absolute limit |
| `RATE_LIMIT_PER_MINUTE`, `LOGIN_ATTEMPTS_PER_15_MIN` | api | 600, 10 | per IP or per API key |
| `METRICS_TOKEN` | api | — | bearer token for `/metrics`; without it `/metrics` is closed in production |
| `DOCS_ENABLED` | api | true | OpenAPI UI at `/api/v1/docs` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID` | worker | — | AI explanations; optional |
| `AI_MODEL`, `AI_EFFORT` | worker | `claude-opus-5-5`, `medium` | |
| `RECOMPUTE_CONCURRENCY`, `EXPLAIN_CONCURRENCY` | worker | 2, 4 | per process |
| `NIGHTLY_LOCAL_HOUR` | worker | 4 | each building's local hour for nightly reprocessing |

## Scaling

- The API is stateless: run as many replicas as needed. Sessions live in the database.
- Workers can run in parallel. Recompute jobs are coalesced per building (one queued, one active), so two workers
  never process the same building at once.
- Raw telemetry is compressed after 30 days. Reports read daily roll-ups and stay fast as history grows.

## Observability

- `/healthz` (liveness) and `/readyz` (database reachable) on the API; `/healthz` on the worker's health port.
- Prometheus metrics: `flowcarbon_api_http_request_duration_seconds`, `flowcarbon_api_*` process metrics,
  `flowcarbon_worker_jobs_total{queue,outcome}`, `flowcarbon_worker_job_duration_seconds`.
- JSON logs with request ids (`x-request-id` is accepted and echoed). Authorization headers and cookies are redacted.
- Every mutation is in the organisation's audit log (`GET /api/v1/orgs/{orgId}/audit-log`).
