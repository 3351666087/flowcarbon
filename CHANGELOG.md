# Changelog

## 0.1.0 — 2026-10-16

First release. All bundled data is simulated.

- **Engine**: door-count occupancy with nightly reset and idle decay; 15-minute floor intervals from sub-meters or
  rated power × run time with per-bucket data tiers; four documented rules with exclusive attribution; same-weekday
  headcount forecast; strategy annualisation by day type; EPC finance; flat and time-of-use tariffs; Scope 2 by
  location- and market-based methods with factor provenance.
- **Data platform**: PostgreSQL 17 + TimescaleDB, row-level security for every organisation, NOBYPASSRLS runtime
  role, compressed raw telemetry, daily roll-ups, shared MEE/NBS emission-factor library, append-only audit log.
- **API**: sessions and API keys, role matrix with tenant scoping, idempotent telemetry ingestion, findings review,
  forecasts, strategies and EPC, reports (JSON/CSV) and frozen snapshots, overtime requests, organisation
  administration, OpenAPI 3.1, metrics, health probes.
- **Worker**: coalesced per-building recompute, nightly reprocessing in each building's time zone, AI explanations
  with Claude (structured output, closed citation list, refusal fallback), dead-letter handling.
- **Web**: floors, opportunities with evidence charts and AI panel, forecast, simulation, overtime requests, report,
  devices and data health, organisation settings; English and Simplified Chinese; light and dark themes.
- **Delivery**: server and web images, Docker Compose profiles, CI with database tests, tagged multi-arch image
  publishing.
