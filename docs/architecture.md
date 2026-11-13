# Architecture

```
 gateways / BMS exports ──► API (Fastify) ──► PostgreSQL 17 + TimescaleDB
         (API keys)          │  ▲                 ▲
                             │  │ sessions        │ jobs (pg-boss)
 browser (Next.js) ──────────┘  │                 │
                                └──── worker ─────┘──► Anthropic API (AI text, optional)
```

## Packages

| Package | Responsibility | Depends on |
|---|---|---|
| `@flowcarbon/core` | Pure domain engine: calendars and time zones, occupancy, interval building, rules, forecasts, strategies, plans, the digital twin, EPC finance, tariffs, Scope 2, reports. No I/O. | — |
| `@flowcarbon/sim` | Deterministic simulator of a 12-floor tower for tests and demos. | core |
| `@flowcarbon/db` | Drizzle schema, SQL migrations (hypertables, RLS, grants), `withOrg`, shared reference data. | — |
| `@flowcarbon/security` | argon2id password hashing, tokens, API keys. | — |
| `@flowcarbon/pipeline` | Database-backed pipeline shared by API and worker: ingestion, interval recompute, daily roll-ups, detection, forecasts, reports, strategies, plans. | core, db |
| `@flowcarbon/demo` | Seeds a demonstration organisation through the real ingestion path. | all of the above |
| `apps/api` | HTTP API, authentication, RBAC, OpenAPI. | pipeline, security |
| `apps/worker` | Background jobs: recompute after ingestion, nightly forecasts, AI explanations, overviews and assistant replies. | pipeline |
| `apps/web` | Web application. | API over HTTP; `core/twin` for the digital twin's model, which runs in the browser |

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
6. **Buildings side by side** (`GET /orgs/:orgId/compare`, `packages/core/src/portfolio.ts`) reads the same
   `floor_daily` roll-ups for each building, over one window ending at the organisation's latest whole day, plus the
   measures' existing verification (`summariseMeasures`, shared with the measures list). It adds no storage.

### Tenant-controlled vs building-controlled energy

A property manager's question about a kWh is usually "do I call the tenant or engineering?". FlowCarbon answers it
**by system, not by metered area** (`packages/core/src/responsibility.ts`). `floor_daily` stores each day's kWh per
system (`kwh_hvac`, `kwh_lighting`, `kwh_plug`, migration 0013); the mapping is applied when reading, with the lease
in force on that local day (`leasedOn`), so it can change without another migration. A day counts as split only
when `systems_split` is true (its three systems add up to `kwh_total`; the pipeline always derives them from the same
intervals, migration 0014 marks older days). The energy of any other day is reported as unsplit (`partyUnsplit`,
`unsplitKwh`) and is neither party's: it is not guessed or spread in proportion.

| System on a floor | Leased that day | Vacant that day | Why |
| --- | --- | --- | --- |
| Cooling (`hvac`, includes the floor's share of the central plant) | building | building | The plant and the BMS schedule are run by the property. |
| Lighting | tenant | building | In-unit lighting is switched by the tenant. |
| Plug loads | tenant | building | The tenant's own equipment. |

Findings follow the same idea (`findingResponder`): the three cooling rules go to engineering;
`lights_on_empty_night` goes to the tenant on a leased floor and to engineering on a vacant one.

Limits, printed as a report disclosure after the boundary: there are **no common-area meters**. Lobbies, corridors,
lifts and plant rooms are not metered separately and are not in the report, and ingestion only accepts devices
assigned to a floor. Central-plant energy is already inside each floor's cooling (the simulator's `HVAC_KW` is the
floor's share), so a separate plant meter would count it twice. A real common-area model would add a `served_area`
attribute on meters, accept floorless common meters at ingest and roll them up separately. Some buildings let tenants
run their own fan coils; a per-building override of the mapping is a possible follow-up.

## Plans, the assistant and the digital twin

Every figure here is computed from data and the words around it may come from AI; see
[ADR 0004](adr/0004-numbers-from-code-words-from-ai.md).

1. **Planning.** `planData` in `packages/pipeline/src/plans.ts` loads the last 28 whole days of data, the open findings
   not already in an active measure, and the active measures, and calls `buildPlan` in `packages/core/src/plans.ts`. A
   candidate is a (floor, strategy) pair covering findings through the existing `covers()`; each finding counts once.
   The options (weekends, weekdays, balanced) take candidates largest first until the target is reached. `after`, `low`
   and `high` apply `REALISATION` to the covered energy, with cost and CO₂e at the building's blended rates over the
   window. Options and target checks stand on what is already adopted: `recorded` is the window as the data shows it,
   and `before` takes off what active measures are expected to save, except on-site checks, which switch nothing.
   `GET /strategy-board` returns this with no target and no AI.
2. **Assistant.** `POST /assistant` stores a pending turn in `assistant_turns` and queues `assistant-reply`. The worker
   reads the intent, plans, and streams structured prose into `draft` for the page to poll, every snapshot held to the
   plan's numbers first. `regexIntent` reads only the page's chips and a goal or a command put in the plainest way, and
   it reads by elimination: every word must be accounted for, or it returns nothing. Everything else goes to one
   structured model call, which is given the building's floor labels and turns "the top floor", "F3 to F5" or "5楼以上"
   into them. The grammar stays small on purpose: a wrong guess here is a button acting on the wrong floors, so a new
   wording belongs with the model. Without a model such a request gets the general reply and no option. A
   named part of the building becomes `unknownPlaces`, and the plan is limited to the floors named, so it is never read
   as the whole building. If there is no client, the model fails or a
   demo organisation is past its AI quota, a templated reply finishes the turn with `model: null`; `prompt_version` is
   `template` when no model was asked, and only such turns stay out of the quota. An empty plan names what the building
   has open instead, and a request for a temperature is told no option sets one. When a job runs out of retries the
   dead-letter handler answers from the template or, if the plan itself cannot be made, ends the turn failed; the API
   ends one still pending after 20 minutes, which covers a job that was lost. Asked for another language, a finished
   turn is told again by the template over the same plan. A plan is as old as its turn, so the API reports the live
   status of what a turn applied and marks an answer whose plan counted other measures than the active ones.
3. **Applying.** `POST /assistant/turns/:turnId/apply` creates one measure per action through the helper behind
   `findings/:id/measure`, joining an existing measure rather than duplicating it. It is idempotent, and `undo` cancels
   what it created. `POST /strategy-board/adopt` makes a done turn and takes the same path. Measures are `planned`, or
   `in_effect` in a demo organisation, where the simulated hardware obeys, whichever way they were adopted, and
   verification treats them like any other: `verify` looks back from the floor's last data, as a plan does, and counts
   only days with data, so a measure with none after it waits instead of reading as a saving. Until then its figure
   comes from `measureFooting` in `packages/pipeline/src/plans.ts`, on the plan's own window and `splitFindings`, so a
   measure shows its option's expected saving a week at a time, with the range, and the Measures total agrees with
   `adoptedKwh`. `BEFORE_DAYS` only sets the before and after comparison.
   Adopting holds a per-building advisory lock, because finding a floor's measure and creating it are two steps.
4. **Community.** `community_strategies` is the one deliberate exception to tenant isolation: any member may read rows
   not withdrawn, and only the owning organisation may write them. A row publishes an alias, a strategy mix as floor
   shares, a floor count, an area band and a result, and never a tenant name or floor label. Rows with no organisation
   are seeded by the owner connection (`community.mjs`, the `community` Compose service), from public datasets and from
   the simulated tower, which says so. What a publisher types is checked against the building's floors and tenants,
   however it is spelled. Using one reruns the planner on your own
   building, limited to that mix, and stores a turn, so it takes the permission to ask; `GET .../plan` previews the same
   thing for anyone who can read findings and stores nothing.
5. **Digital twin.** `packages/core/src/twin.ts` builds a floor plan from the floor's area and `layout`, and works out
   what a policy leaves on. The plan is a rectangle, since a footprint is not stored. Light is a sum of point sources,
   `E = I · cos³θ / h²`, with the desk 2.0 m below the ceiling and rows about 2.4 m apart; brightness at a desk is E
   with the current state over E with every light on. On an open floor every desk has one row above it, and the
   rows around it contribute most of what it gets: its own row alone leaves about 40 % in the middle of the floor, so
   the policy that follows people keeps the row on each side too, which leaves 74 to 86 % on the 1,600 m² demo floor. Walls stop light, so a room in use keeps 100 %. Power is each device's share of the
   floor's rated power, and cooling stays at the floor's zone-only share while any fan coil runs. The page calls these
   functions directly with no API; only the chosen layout is stored (`PATCH /floors/:floorId/layout`).

## Tenancy and security

See [ADR 0001](adr/0001-tenant-isolation-with-rls.md) and [ADR 0002](adr/0002-telemetry-isolation.md).
Roles: `owner`, `admin`, `property_manager`, `energy_analyst`, `engineer`, `tenant_admin` (limited to the floors
its tenant leases) and `viewer`.

## Scale

Per building with 12 floors, 15-minute buckets: about 3,000 raw rows and 1,150 interval rows a day. The demo
month (28 days, 80,000 raw rows) ingests and processes in about 9 seconds on a laptop. Raw telemetry is
compressed after 30 days; derived intervals can be dropped after a retention period because roll-ups keep the
daily figures.
