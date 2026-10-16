# ADR 0002 — Raw telemetry: compression instead of row-level security

- Status: accepted
- Date: 2026-10-16

## Context

Raw telemetry (`energy_readings`, `door_counts`) is by far the largest data set: a 12-floor building with
sub-meters and door counters produces about 3,000 rows a day, so a portfolio of 100 buildings writes about
110 million rows a year. These tables are TimescaleDB hypertables, and compression (the columnstore) cuts their
size by an order of magnitude.

TimescaleDB refuses to enable the columnstore on a table with row-level security
(`columnstore cannot be used on table with row security`). We must choose between RLS and compression on these
two tables.

## Decision

`energy_readings` and `door_counts` are compressed (segment by `device_id`, order by time, after 30 days) and are
**not** under RLS. Isolation is enforced by construction instead:

1. The rows hold only numbers keyed by `device_id` (and, for door counts, `floor_id`). They contain no names, no
   free text and no personal data.
2. **Writes**: the only write path is `ingestTelemetry`. It resolves external device ids through the
   RLS-protected `devices` table inside the caller's organisation context, so a device of another
   organisation is simply unknown and the whole batch is rejected.
3. **Reads**: the pipeline reads raw telemetry only for device or floor ids it has just loaded from RLS-protected
   tables in the same transaction. No API endpoint reads raw telemetry directly.
4. `org_id` is still stored on every row, so deletion and audits per organisation remain simple.

The lower-volume event tables (`hvac_events`, `lighting_events`) and all derived tables (`floor_intervals`,
`floor_daily`, findings, forecasts) stay under RLS.

## Consequences

- Storage for raw telemetry stays manageable at portfolio scale.
- The guarantee for these two tables rests on code paths, so they are covered by integration tests (a device of
  another organisation is rejected; deleting an organisation removes its telemetry).
- If TimescaleDB later supports RLS with the columnstore, enable the `org_isolation` policy on both tables; no
  schema change is needed.
