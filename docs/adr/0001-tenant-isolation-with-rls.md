# ADR 0001 — Tenant isolation with PostgreSQL row-level security

- Status: accepted
- Date: 2026-10-16

## Context

FlowCarbon is a multi-tenant SaaS. A customer organisation (usually a property-management company) owns
buildings, floors, tenants (the companies renting floors), devices, telemetry, findings and reports. A bug that
forgets an `org_id` filter must not leak one customer's data to another.

## Decision

1. Every organisation-owned table carries `org_id`.
2. Row-level security is enabled on those tables with one policy, `org_id = app_current_org()`, for both
   `USING` and `WITH CHECK`. `app_current_org()` reads the transaction-local setting `app.org_id`.
3. The API and worker connect as `flowcarbon_app`, a role that owns no tables and has `NOBYPASSRLS`.
   Migrations run as the database owner.
4. All organisation-scoped work goes through `withOrg(db, orgId, fn)`, which opens a transaction and sets
   `app.org_id` with `set_config(..., true)` so the value cannot outlive the transaction or leak through the
   connection pool.
5. Identity tables (`users`, `memberships`, `sessions`, `api_keys`, `invitations`, `organizations`) are not
   under RLS: sign-in and API-key lookup happen before an organisation is known. They are only reached through
   the authentication module.
6. The shared emission-factor library (`org_id IS NULL`) is readable by every organisation and writable by none
   at runtime; organisations can add their own factors.
7. `audit_log` is append-only for the application role (`UPDATE` and `DELETE` revoked).

Queries still filter by organisation and building explicitly. RLS is the second line of defence, not the only one.

## Consequences

- An unscoped query returns no rows rather than other customers' rows (tested in
  `packages/demo/test/database.integration.test.ts`).
- Every request pays for one `set_config` call and runs in a transaction.
- Cross-organisation jobs (for example a platform-wide report) need an explicit owner connection and are
  reviewed as such.
- Foreign-key cascades run with owner rights, so deleting an organisation removes its rows in every table.
