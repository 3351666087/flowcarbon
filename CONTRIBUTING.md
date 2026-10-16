# Contributing

1. Node.js 22 and Docker. `npm install`, then `npm run db:up` and `npm run db:migrate` (see README).
2. Keep the domain engine (`packages/core`) free of I/O. Database access belongs in `packages/pipeline`/`packages/db`,
   HTTP in `apps/api`.
3. Every rule threshold needs a rationale in `RULE_PARAM_RATIONALE`; every number shown to users needs its data tier.
4. Schema changes: edit `packages/db/src/schema`, then `npm run db:generate`; never edit an applied migration.
   Organisation-owned tables need `org_id` and an entry in the RLS list (see `drizzle/0001_timescale_rls.sql`).
5. API changes: run `npm run api-types -w @flowcarbon/web` and commit the regenerated client types (CI checks them).
6. Before a pull request: `npm run lint`, `npm run typecheck`, and `npm test` with `TEST_DATABASE_URL` set.
7. Bundled data must stay simulated. Do not commit real building data, personal data or credentials.
