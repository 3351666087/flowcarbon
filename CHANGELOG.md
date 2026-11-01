# Changelog

## 0.2.0 — 2026-11-02

- **Assistant on the first page.** Ask for a target ("bring avoidable energy down to 5%") or say what a smart home
  would hear ("turn the lights off at night"). The answer is up to three options (weekends, weekdays, balanced), each
  with its expected saving and range. The page's chips and the plainest sentences are read without a model, in both
  languages, and every word of them has to be accounted for. Anything else goes to one structured model call, given
  the building's floor labels, so "the top floor", "F3 to F5" and "周末以外" are read for what they mean. Without a
  model such a request gets the general reply and no option, because a guess would be a button acting on the wrong
  floors. The plan is deterministic; the model only writes the words, in the language asked. With no API key, when the
  model fails, or past a demo organisation's daily AI answers, a templated reply goes out over the same plan. A request
  that finds nothing says what is open instead, and no option stands in for a temperature, which nothing here can set.
  Options act on whole floors, so a request naming a part of the building (the lobby, 会议室, room 301, B座) says it
  cannot pick that out and offers nothing, and a floor below ground is never taken for the floor above with its number.
- **Before and after.** Previewing or applying an option splits the page in two, on phones too: two towers, every
  figure in both columns with its change, the basis and the range under it. The browser's Back closes it. The towers
  mark the floors the option acts on, amber before and teal after. Applying creates real measures through
  the same path as adopting a finding, with undo. In a demo organisation they take effect at once, however they were
  adopted, because there the simulated hardware obeys; elsewhere they stay planned until the change is reported as
  made. Viewers get the preview and a note saying why they cannot apply.
- **A measure's expected figure is its plan's.** Until the data measures it, a measure shows what its option gave, a
  week at a time: the same window, the same 80 % with the range around it, and a finding counted once. Measures and
  the "Adopted so far" line now add up to the same energy, and an on-site check, which switches nothing, expects
  nothing and says so, in effect as well as planned. So does a cancelled measure, with no figure or range. A planned
  measure keeps its figure on a building whose data has ended. Only days with data count after a measure takes effect:
  without any it says it is waiting for data, and nothing reads as measured.
- **Overtime requests could not be created.** Every floor came back with no tenant, because the lookup compared the
  lease with itself, so the form's floor list was empty for everyone. Floors now carry their tenant from the live lease.
- **One period for one figure.** The first page's "last 28 days" now stops at the last whole day, as a plan does:
  today, still coming in, no longer counted as a day of its own.
- **Strategies page.** The second nav item is now Strategies, with tabs for Strategies, Opportunities and Measures.
  Compare options, adopt one and watch it move into a running "Adopted so far" line, with a 7-day forecast of expected
  energy before and after and the people forecast advice. A priority of the AI overview can be compared the same way.
  Forecast leaves the nav; `/findings`, `/forecast`, `/go/` links and the Android shortcuts still resolve.
- **Community.** A building can publish a strategy under an alias and reuse another's, like a skill: the planner
  reruns the mix on your own building. Rows carry shares and bands only, never tenant names or floor labels, and an
  alias or title that names one is refused however it is spelled. Badges say whether a figure is expected or measured,
  and whether it comes from a public dataset or a simulated building. The rail starts empty: `community` in the
  Compose file lists the datasets' strategies, and has to run on an upgrade (see `docs/deployment.md`).
- **Digital twin.** A simulated floor, open plan or meeting rooms, from the floor's own area and rated power. Lights
  switch by row or by room and fan coils by zone, under four policies: all on, rows around seated people only, rooms
  in use only, and away. Before and after plans show lit fittings, fan coils, kW and the brightness at each person from a
  point-source model. Seats start from the live count and can be tapped. It is labelled as a simulation that assumes
  controls can switch equipment directly.
- **AI text follows the language.** AI overviews and explanations are kept per language. Switching the interface
  shows the text in that language, or requests it once; the wrong language is never on screen. A measure's note that
  began as the assistant's sentence says which language it is in and shows on request. The Report page's notes and
  labels follow the language too; the CSV and a frozen report keep the English notes the API gives.
- **The shared demo** can be chosen at sign-up, read-only, next to a demo building of one's own.
- **"Simulated data"** shows only on demo organisations. Investment estimates are in yuan: a building in another
  currency gets none in a plan, and Simulate shows them in yuan with no payback or contract figures.
- **Floors in detail** (the live floor list and the daily chart) moved to Devices & data. Tenants keep them on the
  first page, which is the page they have.
- **Numbers from code, words from AI**: see [ADR 0004](docs/adr/0004-numbers-from-code-words-from-ai.md).
- `apps/web` now depends on `@flowcarbon/core`, for the twin's model only, so a tap on a desk needs no round trip.
- Migration `0011`: `assistant_turns`, `community_strategies`, `floors.layout`, and `locale` on `ai_briefs` and
  `ai_explanations`. Migration `0012` labels each stored text by the language it is written in, which is not always
  the one its requester uses now. API types are regenerated.

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
