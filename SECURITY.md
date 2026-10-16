# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** (Security → Advisories) on
this repository rather than in a public issue. Include the affected version, steps to reproduce and the impact you
expect. You will get an acknowledgement within five working days.

## Design summary

- **Tenant isolation**: PostgreSQL row-level security on every organisation-owned table, enforced for the runtime
  role, which cannot bypass it ([ADR 0001](docs/adr/0001-tenant-isolation-with-rls.md)); raw telemetry is isolated
  by construction ([ADR 0002](docs/adr/0002-telemetry-isolation.md)). Integration tests run as the runtime role.
- **Authentication**: argon2id password hashes (OWASP parameters, transparent rehash), opaque session tokens stored
  only as SHA-256, HttpOnly SameSite=Lax cookies (`__Host-` prefixed over HTTPS), sliding expiry with an absolute
  limit, uniform answers and timing for unknown accounts, sign-in rate limits.
- **CSRF**: cookie-authenticated writes must carry an allowed `Origin`.
- **API keys**: 256-bit random, shown once, stored as SHA-256, scoped (`telemetry:write`, `read`,
  `overtime:write`), optionally limited to one building, expiring and revocable.
- **Authorisation**: role permission matrix enforced server-side; tenant administrators are limited to the floors
  their tenant leases; organisations the caller does not belong to answer 404.
- **Audit**: every mutation is written to an append-only audit log (the runtime role cannot update or delete it).
- **Input**: every request body, query and header is validated (zod); telemetry batches are validated as a whole.
- **Headers**: Helmet on the API, CSP and HSTS on the web app; JSON logs redact credentials.
- **AI**: the assistant receives only stored data, cannot change settings and may cite only a closed reference list.

## Known limitations

- `npm audit` reports moderate advisories in `drizzle-kit`'s development-only esbuild dependency; it is not part of
  the production images.
- Single sign-on (OIDC/SAML) and multi-factor authentication are not implemented yet.
