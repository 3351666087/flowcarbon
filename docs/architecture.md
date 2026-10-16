# Architecture

```
 gateways / BMS exports ──► API (Fastify) ──► PostgreSQL 17 + TimescaleDB
         (API keys)          │  ▲                 ▲
                             │  │ sessions        │ jobs (pg-boss)
 browser (Next.js) ──────────┘  │                 │
                                └──── worker ─────┘──► Anthropic API (explanations, optional)
```

## Packages

| Package | Responsibility | Depends on |
|---|---|---|
| `@flowcarbon/core` | Pure domain engine: calendars and time zones, occupancy, interval building, rules, forecasts, strategies, EPC finance, tariffs, Scope 2, reports. No I/O. | — |
| `@flowcarbon/sim` | Deterministic simulator of a 12-floor tower for tests and demos. | core |
| `@flowcarbon/db` | Drizzle schema, SQL migrations (hypertables, RLS, grants), `withOrg`, shared reference data. | — |
| `@flowcarbon/security` | argon2id password hashing, tokens, API keys. | — |
| `@flowcarbon/pipeline` | Database-backed pipeline shared by API and worker: ingestion, interval recompute, daily roll-ups, detection, forecasts, reports, strategies. | core, db |
| `@flowcarbon/demo` | Seeds a demonstration organisation through the real ingestion path. | all of the above |
| `apps/api` | HTTP API, authentication, RBAC, OpenAPI. | pipeline, security |
| `apps/worker` | Background jobs: recompute after ingestion, nightly forecasts, AI explanations. | pipeline |
| `apps/web` | Web application. | API over HTTP |

## Data flow

1. **Ingestion.** A gateway posts a batch (readings, door counts, HVAC and lighting state changes) with an
   `Idempotency-Key`. `ingestTelemetry` validates devices and timestamps, writes raw rows (late corrections
   overwrite) and returns the local dates the batch touches.
2. **Recompute.** A job rebuilds 15-minute floor intervals for those dates: occupancy from door counts (nightly
   reset at 04:00, idle decay at night), energy per system from sub-meters where present or rated power × run
   time otherwise, with the data tier recorded. Daily roll-ups (`floor_daily`) are written in the same
   transaction.
3. **Detection.** The rules run over the dates with one day of context and reconcile stored findings by
   fingerprint `(floor, rule, start)`. Open findings that late data disproves are removed; reviewed findings are
   kept.
4. **Forecasts** of after-hours headcount per floor are refreshed nightly from the last six weeks of roll-ups.
5. **Reports and strategies** read roll-ups and findings only, so their cost does not grow with telemetry volume.

## Tenancy and security

See [ADR 0001](adr/0001-tenant-isolation-with-rls.md) and [ADR 0002](adr/0002-telemetry-isolation.md).
Roles: `owner`, `admin`, `property_manager`, `energy_analyst`, `engineer`, `tenant_admin` (limited to the floors
its tenant leases) and `viewer`.

## Scale

Per building with 12 floors, 15-minute buckets: about 3,000 raw rows and 1,150 interval rows a day. The demo
month (28 days, 80,000 raw rows) ingests and processes in about 9 seconds on a laptop. Raw telemetry is
compressed after 30 days; derived intervals can be dropped after a retention period because roll-ups keep the
daily figures.
