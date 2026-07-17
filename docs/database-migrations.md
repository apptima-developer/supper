# Database Migrations

Versioned, reviewable SQL migrations live in `supabase/migrations/`. Names use `YYYYMMDDNNNN_description.sql`; an applied migration is immutable and later changes require a new version.

## Verification

`npm run verify:migrations` validates naming, ordering, duplicate versions, and empty files. It does not execute SQL and does not contact Supabase.

## Applying Phase 0.2

Apply `supabase/migrations/202607170001_security_foundation.sql` manually through one of these approved paths:

1. Review the complete SQL and its target project.
2. Take the normal database backup or recovery checkpoint.
3. Execute it in the Supabase SQL Editor while authenticated as an authorized database administrator, or use the organization's approved Supabase migration runner.
4. Confirm the row `202607170001` exists in `support_schema_migrations`.
5. Confirm `support_users.auth_version`, `support_login_rate_limits`, and `support_record_login_failure` exist and the service role grants are present.
6. Configure the new production environment variables, then deploy the application.

Do not attempt to execute arbitrary SQL through the Supabase REST API. The repository verifier deliberately performs no database mutation.

## What the migration changes

- Creates `support_schema_migrations` if absent.
- Adds `support_users.auth_version` with a non-destructive default of `1` when `support_users` exists.
- Creates the dedicated persistent login rate-limit table and supporting index.
- Creates an atomic PL/pgSQL function that records a failed login and establishes a lock.
- Enables RLS and grants only the server-side Supabase service role the required access.
- Records the migration version idempotently.

No table is dropped, no existing password is reset, and no production data is copied or deleted.

## Rollback considerations

Prefer rolling application code forward. If a rollback is required, redeploy the prior application first. `auth_version` and `support_schema_migrations` can remain safely. Remove the rate-limit function/table only during a controlled maintenance window after confirming no deployed code uses them. Never delete rate-limit state while the hardened login route is active.
