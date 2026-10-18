<p align="center">
  <img src="docs/media/flowcarbon-en.svg" alt="FlowCarbon: a simulated office tower is sensed floor by floor, waste is detected by rules, explained by AI, priced as an energy performance contract and reported as Scope 2" width="100%">
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/3351666087/flowcarbon/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/3351666087/flowcarbon/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/3351666087/flowcarbon/releases"><img alt="Release" src="https://img.shields.io/github/v/release/3351666087/flowcarbon?color=0d7068&label=release"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-0d7068"></a>
  <a href="docs/deployment.md"><img alt="Docker images" src="https://img.shields.io/badge/ghcr.io-server%20%7C%20web-0d7068?logo=docker&logoColor=white"></a>
  <img alt="Node 22" src="https://img.shields.io/badge/node-22-0d7068?logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-0d7068?logo=typescript&logoColor=white">
</p>

# FlowCarbon

**Occupancy-driven after-hours energy and carbon management for office buildings.**

Office towers cool and light whole floors on fixed schedules. After hours and at weekends the building keeps
paying for floors nobody is on, while the few people who stay late often get no cooling at all. FlowCarbon
counts people per floor, finds the hours a floor was cooled or lit for nobody, forecasts after-hours headcount,
lets tenants book cooling for their own floor instead of the whole tower, and prices the saving under an
energy performance contract — with every number traceable to the rule and the data behind it.

> **Status: 0.1.** The engine, data platform, API, worker and web app are implemented and tested end to end.
> All bundled data is **simulated**; nothing here describes a real building.

## What it does

<table>
  <tr>
    <td width="33%" valign="top"><b>Sense</b><br>Door counters give people per floor; BMS states and sub-meters give what runs and what it costs. Every kWh is tagged <i>measured</i> or <i>estimated</i>.</td>
    <td width="33%" valign="top"><b>Detect</b><br>Four rules with a physical meaning and a written rationale for every threshold. Each interval's energy is counted by at most one rule.</td>
    <td width="33%" valign="top"><b>Explain</b><br>Claude explains a finding, recommends one action from a fixed strategy list and cites only a closed list of sources. Rules decide; AI explains; people choose.</td>
  </tr>
  <tr>
    <td valign="top"><b>Forecast & simulate</b><br>After-hours headcount for the next seven days per floor; strategies annualised by day type; EPC split, paybacks and NPV.</td>
    <td valign="top"><b>Report</b><br>Electricity and Scope 2 by the location- and market-based methods, with factor provenance, CSV export and frozen snapshots.</td>
    <td valign="top"><b>Operate</b><br>Multi-tenant with PostgreSQL row-level security, roles with tenant scoping, scoped API keys for gateways, audit log, metrics.</td>
  </tr>
</table>

<p align="center">
  <img src="docs/images/floors.jpg" alt="Floors: live state per floor and the last 28 days" width="49%">
  <img src="docs/images/opportunity.jpg" alt="An opportunity with its evidence, the floor-day chart and an AI explanation" width="49%">
</p>
<p align="center"><sub>Screens from the bundled simulation of “Tower A”; no real building or person is shown.</sub></p>

## How it fits together

```mermaid
flowchart LR
  subgraph building["Building (simulated)"]
    door[Door counters]
    bms[BMS / HVAC states]
    meter[Sub-meters]
  end
  door & bms & meter -->|API key · idempotent batches| api
  web["Web app · Next.js<br/>English / 中文"] -->|session cookie| api
  api["API · Fastify<br/>roles · audit · OpenAPI"] --> db[("PostgreSQL 17 + TimescaleDB<br/>row-level security")]
  api -->|jobs| queue[["pg-boss"]]
  queue --> worker["Worker<br/>intervals · rules · forecasts"]
  worker --> db
  worker -->|structured output| claude["Claude<br/>explains, never decides"]
```

## Principles

1. **Rules decide, AI explains.** Waste is detected by rules with a physical meaning and a documented
   rationale for every threshold. The AI explains findings and recommends one action from a fixed strategy
   list; it never decides and never changes building settings.
2. **No estimate is shown as a measurement.** Every energy figure carries its data tier (`measured` from a
   sub-meter, or `estimated` from rated power × run time).
3. **Cost first, carbon alongside.** Owners act on electricity cost. Scope 2 is reported by both the
   location-based and the market-based method with factor provenance. It is an energy and carbon report, not an
   ESG report.
4. **Multi-tenant from day one.** Every organisation's rows are isolated by the database itself, and the
   runtime role cannot bypass it.

## Run it

```bash
docker compose -f infra/docker-compose.yml --profile app up -d --build
DEMO_PASSWORD='choose-a-password' docker compose -f infra/docker-compose.yml --profile demo run --rm seed
open http://localhost:3000        # sign in as manager@flowcarbon-demo.example
```

Prebuilt images: `ghcr.io/3351666087/flowcarbon-server` and `ghcr.io/3351666087/flowcarbon-web`
(linux/amd64 and linux/arm64). API documentation is served at `http://localhost:4000/api/v1/docs`.
See [deployment](docs/deployment.md) for production settings.

## The rules

| Rule | Kind | What it checks |
|---|---|---|
| `hvac_unrequested_non_working` | waste | On a weekend or holiday a floor is cooled outside its own request with nobody there, while another floor did request cooling. |
| `hvac_empty_floor` | waste | Cooling continues after the floor has been empty for the grace period (default 30 min). |
| `lights_on_empty_night` | waste | Lighting above the security level stays on at night on an empty floor. |
| `full_floor_few_people` | opportunity | The whole floor is cooled for fewer people than the threshold; a zone setback would serve them. |

Pre-cooling and arrival around the start of the working day are exempt. Thresholds and their rationale live in
[`packages/core/src/rules.ts`](packages/core/src/rules.ts).

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict), Node.js 22, npm workspaces |
| Data | PostgreSQL 17, TimescaleDB 2.30 (hypertables, compression), Drizzle ORM, row-level security |
| API | Fastify 5, zod, OpenAPI 3.1, argon2id, Prometheus metrics |
| Jobs | pg-boss 12 |
| AI | Claude via the Anthropic SDK (structured output, refusal fallback) |
| Web | Next.js 16, React 19, Tailwind CSS 4, TanStack Query, Recharts |
| Delivery | Docker images, Docker Compose, GitHub Actions CI and release |

## Repository layout

| Path | What it is |
|---|---|
| `packages/core` | Pure domain engine: calendars, door-count occupancy, 15-minute floor intervals, rules, forecasts, strategies and EPC finance, overtime, tariffs, Scope 2, reports. No I/O. |
| `packages/sim` | Deterministic simulator of a 12-floor tower for development, tests and demos. |
| `packages/db` | Schema and migrations: hypertables, row-level security, runtime role grants, shared emission-factor library. |
| `packages/pipeline` | Ingestion, interval recompute, daily roll-ups, detection, forecasts, reports and strategies on the database. |
| `packages/security` | argon2id password hashing, opaque tokens, API keys. |
| `packages/jobs` | Job queues: definitions, owner-only schema install, runtime client. |
| `packages/demo` | Seeds a demonstration organisation through the real ingestion path. |
| `apps/api` | HTTP API. |
| `apps/worker` | Background jobs and AI explanations. |
| `apps/web` | Web application. |
| `docs/` | [Architecture](docs/architecture.md), [deployment](docs/deployment.md), [decision records](docs/adr/). |

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
npm test                         # set TEST_DATABASE_URL to include database and API tests
npm run lint
```

`TEST_DATABASE_URL` must point at the server as its owner, for example
`postgres://flowcarbon:flowcarbon-dev@localhost:5432/postgres`. Each run creates and drops its own database and
exercises the pipeline as the non-privileged application role, so row-level security is tested for real.

`npm run snapshot -- --out snapshot.json` seeds a throw-away database for the README window, runs the whole
pipeline and writes one self-contained JSON file (floors, daily roll-ups, findings with evidence, forecasts,
strategies and EPC, the report with both Scope 2 methods, factors, devices). With `ANTHROPIC_API_KEY` set it also
stores AI explanations for the largest finding of each rule, in English and Chinese. Static prototypes and reviews
use it instead of running the stack.

The README animation is generated with `node scripts/hero/build-hero.mjs` (copy in `scripts/hero/strings.mjs`), the
repository's social preview with `node scripts/hero/build-poster.mjs`.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Changes are listed in
[CHANGELOG.md](CHANGELOG.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
