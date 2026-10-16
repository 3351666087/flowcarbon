# FlowCarbon

**Occupancy-driven after-hours energy management for office buildings.**

Office towers cool and light whole floors on fixed schedules. After hours and at weekends the building keeps
paying for floors nobody is on, while the few people who stay late often get no cooling at all. FlowCarbon
counts people per floor, finds the hours a floor was cooled or lit for nobody, forecasts tomorrow's after-hours
headcount, lets tenants book cooling for their own floor instead of the whole tower, and prices the saving
under an energy performance contract — with every number traceable to the rule and the data behind it.

> Status: 0.1 — the engine, data platform, API, worker and web app are implemented and tested end to end. All
> bundled data is **simulated**; nothing here describes a real building.

![Floors: live state per floor and the last 28 days](docs/images/floors.jpg)

![An opportunity with its evidence, the floor-day chart and an AI explanation](docs/images/opportunity.jpg)

*Screens from the bundled simulation of “Tower A”; no real building or person is shown.*

## Principles

1. **Rules decide, AI explains.** Waste is detected by rules with a physical meaning and a documented
   rationale for every threshold. An AI agent explains findings and recommends one action from a fixed strategy
   list; it never decides and never changes building settings.
2. **No estimate is shown as a measurement.** Every energy figure carries its data tier (`measured` from a
   sub-meter, or `estimated` from rated power × run time).
3. **Cost first, carbon alongside.** Owners act on electricity cost. Scope 2 is reported by both the
   location-based and the market-based method with factor provenance. It is an energy and carbon report, not an
   ESG report.
4. **Multi-tenant from day one.** Organisations, buildings, tenants and roles are isolated in the data model.

## Repository layout

| Path | What it is |
|---|---|
| `packages/core` | Pure domain engine: time zones and working calendars, door-count occupancy, telemetry → 15-min floor intervals, the rules engine, forecasting, strategies and EPC finance, overtime requests, tariffs (flat and time-of-use), Scope 2 accounting, reports. No I/O. |
| `packages/sim` | Deterministic simulator of a 12-floor tower (door counts, BMS states, lighting, sub-meters) for development and tests. Never used for real buildings. |
| `packages/db` | Database schema and migrations (PostgreSQL 17 + TimescaleDB): hypertables, row-level security, runtime role grants, shared emission-factor library. |
| `packages/pipeline` | Database-backed pipeline shared by the API and the worker: validated idempotent ingestion, interval recompute, daily roll-ups, detection, forecasts, reports, strategies. |
| `packages/security` | argon2id password hashing, opaque tokens, API keys. |
| `packages/demo` | Seeds a demonstration organisation from the simulator through the real ingestion path. |
| `packages/jobs` | Background job queues (pg-boss): queue definitions, owner-only schema install, runtime client. |
| `apps/api` | HTTP API (Fastify 5, zod, OpenAPI 3.1 at `/api/v1/docs`): sessions and API keys, role-based access with tenant scoping, CSRF origin checks, rate limits, audit log, Prometheus metrics. |
| `apps/worker` | Background jobs on pg-boss: recompute after ingestion (coalesced per building, chunked backfills), hourly maintenance that runs each building's nightly work in its own time zone, AI explanations with Claude (structured output, closed citation list, server-side refusal fallback), dead-letter handling, health and metrics. |
| `apps/web` | Web application (Next.js 16, React 19, Tailwind 4): floors, opportunities with evidence and AI explanations, forecast, simulation, overtime requests, report, data health, settings. English and Simplified Chinese. Typed against the API's OpenAPI document. |
| `docs/` | Architecture, data model, rules, deployment. |

## The rules

| Rule | Kind | What it checks |
|---|---|---|
| `hvac_unrequested_non_working` | waste | On a weekend or holiday a floor is cooled although it filed no request and nobody is there, while another floor did request cooling. |
| `hvac_empty_floor` | waste | Cooling continues after the floor has been empty for the grace period (default 30 min). |
| `lights_on_empty_night` | waste | Lighting above the security level stays on at night on an empty floor. |
| `full_floor_few_people` | opportunity | The whole floor is cooled for fewer people than the threshold; a zone setback would serve them. |

Each interval's HVAC energy is attributed to at most one rule, so totals never double count. Pre-cooling and
arrival around the start of the working day are exempt. Thresholds and their rationale live in
[`packages/core/src/rules.ts`](packages/core/src/rules.ts).

## Run it

```bash
docker compose -f infra/docker-compose.yml --profile app up -d --build
DEMO_PASSWORD='choose-a-password' docker compose -f infra/docker-compose.yml --profile demo run --rm seed
open http://localhost:3000        # sign in as manager@flowcarbon-demo.example
```

API documentation is served at `http://localhost:4000/api/v1/docs`. See [deployment](docs/deployment.md) for
production settings.

## Development

Requires Node.js 22 and Docker. Settings are environment variables; see [`.env.example`](.env.example).

```bash
npm install
npm run db:up                    # PostgreSQL 17 + TimescaleDB on localhost:5432
export DATABASE_URL=postgres://flowcarbon:flowcarbon-dev@localhost:5432/flowcarbon
npm run db:migrate               # migrations, shared reference data, job queues
DEMO_PASSWORD='choose-a-password' npm run seed -- --reset   # simulated Tower A, last 28 days
DATABASE_URL=postgres://flowcarbon_app:flowcarbon-app-dev@localhost:5432/flowcarbon npm run dev:api
DATABASE_URL=postgres://flowcarbon_app:flowcarbon-app-dev@localhost:5432/flowcarbon npm run dev:worker   # ANTHROPIC_API_KEY optional
npm run dev -w @flowcarbon/web   # http://localhost:3000
npm test                         # unit tests; set TEST_DATABASE_URL to include database and API tests
npm run lint
```

`TEST_DATABASE_URL` must point at the server as its owner, for example
`postgres://flowcarbon:flowcarbon-dev@localhost:5432/postgres`. Each run creates and drops its own database and
exercises the pipeline as the non-privileged application role, so row-level security is tested for real.

Design notes: [architecture](docs/architecture.md), [deployment](docs/deployment.md) and the
[decision records](docs/adr/). Security: [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
