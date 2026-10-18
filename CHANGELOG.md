# Changelog

## 0.1.2 — 2026-10-18

- **Android app** (`apps/android`): a native shell around the web app with no third-party libraries — launch intro
  on the brand stage, system bars that follow the page's colour, predictive back, an offline screen that reconnects
  by itself, CSV downloads with the session. CI builds, lints and signs the APK and attaches it to releases.
- **Web design: Liquid Glass.** Navigation and controls move onto a glass layer after Apple's iOS 26 material,
  over a slowly drifting backdrop: a floating sidebar on wide screens, and on phones a floating tab bar whose
  selection stretches from tab to tab, lifts into a magnifying lens while a finger slides along it, and folds its
  labels away while the page is read downward (a More menu holds pages beyond five). The header becomes a
  scroll-edge blur with grouped glass controls. On Chromium (including the Android WebView) the glass bends what is
  behind it at its rim, from a per-element refraction map; other browsers get blur, tint and the rim highlight, which
  turns toward the pointer or the phone's tilt. Reduced transparency, increased contrast and reduced motion are
  respected.
- **Sign-in and invitations** take place on a live stage: an isometric tower whose floors glow with occupancy, turn
  amber when cooled while empty and get fixed by a teal scan, leaning toward the pointer or the phone's tilt. The
  form is a glass sheet over it with grouped fields, a password reveal and a refusal shake.
- **Motion**: spring timing for things that travel and things that are pressed, a press bloom under the finger,
  pages that settle in on navigation, cards whose edge lights under the mouse, and the mark as the loading indicator.
- **Web**: the FlowCarbon mark as the site icon, and a web manifest.
- **Deployment**: the edge proxy serves `infra/download` under `/download/`; the pump profile no longer needs the
  app profile, and the pump has no HTTP health check.

## 0.1.1 — 2026-10-18

- **Live demo data**: `npm run pump` / the `pump` compose profile keeps the simulated tower live, simulating the
  elapsed part of each day and ingesting it through the telemetry ingestion function; idempotent, never rewrites
  complete days.
- **Single-host HTTPS**: the `edge` compose profile (Caddy) issues certificates for `DOMAIN` and routes `/api/v1` to
  the API and everything else to the web app.
- **Safer compose defaults**: published ports bind to `127.0.0.1`, every service has a memory cap, PostgreSQL memory
  settings are configurable.
- `npm run snapshot` exports the demo building as one JSON file, computed by the real pipeline in a throw-away
  database, with optional AI explanations from the worker. Static prototypes load it instead of running the stack.
- Building reports and strategy estimates read their rows in a fixed order, so floating-point totals are identical
  every time the same data is reported.

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
