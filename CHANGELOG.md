# Changelog

## 0.1.5 — 2026-10-18

- **Sign-up and sign-in, the way large suites do it.** Email first: an address with an account asks for its
  password; a new address proves itself with a six-digit code, then sets a name, a password and where to start
  (explore the demo organisation read-only, or found an organisation and own it). Every account has both an email
  and a password, and signing in takes both; codes only prove a new address or reset a forgotten password.
  `SIGNUP_OPEN` turns self-service sign-up on, `DEMO_ORG_SLUG` names the organisation to explore.
- **Several accounts on one device**, Google-style: the active session plus up to four kept sessions in a second
  HttpOnly cookie. Switch accounts from the account menu or the sign-in chooser, add another account without
  signing out, and signing out hands over to the next account (or signs everyone out). A session that was not kept
  is signed out when someone else signs in on the same browser.
- **Account menu**: profile, organisations (switch, create one, join the demo), accounts on this device,
  language, appearance (system, light, dark), password, sign out. A bottom sheet on phones, a panel on desktop.
- **New organisations** get a first-building setup (name, city and its grid region, floors, typical floor area);
  home remembers the organisation used last.
- **Interface**: the sign-in stage no longer scrolls; one-time code boxes that accept a pasted or suggested code;
  the sheet changes shape between steps; language and theme switches dissolve instead of jumping, and the first
  paint is already in the reader's language (cookie) and theme (early script); pull to refresh; haptics on tabs,
  switches and segmented controls.
- **Android**: the page runs edge to edge under the system bars (insets handed to the page); links to the site
  (invitations, password resets) open in the app through verified App Links (`/.well-known/assetlinks.json`);
  launcher shortcuts to Opportunities, Floors and Overtime requests; richer haptics; a "FlowCarbon Dev" debug
  build that loads a dev server through `adb reverse`.
- **Copy**: interface text and emails rewritten in plainer English and Chinese.
- Migration `0006`: email codes are keyed by address, so a code can exist before its account does.

## 0.1.4 — 2026-10-18

- **Email codes.** With an SMTP relay configured (`SMTP_URL`, `MAIL_FROM`), people can sign in with a six-digit code
  instead of their password, and reset a forgotten password with one (which signs out every other session). Codes
  last 10 minutes, allow five tries, are stored only as hashes, and a new one retires the last; requesting one
  answers the same whether or not the address has an account. `GET /auth/methods` tells clients whether codes are
  available; without a relay the options stay hidden.
- **Invitations are emailed** to the invitee when mail is configured (`emailed` in the response); the link is still
  shown once.
- The sign-in form gets a segmented control for password or email code, a forgot-password page, and the code field
  takes the code the keyboard offers from the email.
- Migration `0005` adds `email_codes`.

## 0.1.3 — 2026-10-18

- **Keep me signed in.** Sign-in and invitations take a `remember` flag, a switch on the form that is on by
  default and always on in the Android app. A kept session expires after 30 days unused (at most 90 days,
  `SESSION_REMEMBER_DAYS` / `SESSION_REMEMBER_MAX_DAYS`), and its cookie is renewed as the session slides. Other
  sessions keep the 12-hour idle window and now use a browser-session cookie.
- **Fix**: the session cookie kept the expiry of sign-in while the server extended the session, so browsers signed
  users out after 12 hours however active they were.
- Migration `0004` adds `sessions.persistent`.

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
