# Database Migrations

Versioned, reviewable SQL migrations live in `supabase/migrations/`. Names use `YYYYMMDDNNNN_description.sql`; an applied migration is immutable and later changes require a new version.

## Verification

`npm run verify:migrations` validates naming, ordering, duplicate versions, empty files, and that application `SECURITY DEFINER` functions have an explicit signature-matched `PUBLIC` revoke. It does not execute SQL and does not contact Supabase.

## Applying Phase 0.2.1

Apply both migrations manually in immutable version order:

1. `supabase/migrations/202607170001_security_foundation.sql`
2. `supabase/migrations/202607170002_security_foundation_corrections.sql`

Use one of these approved paths:

1. Review the complete SQL and its target project.
2. Take the normal database backup or recovery checkpoint.
3. Execute `202607170001`, commit it, and then execute `202607170002` in the Supabase SQL Editor while authenticated as an authorized database administrator, or use the organization's approved Supabase migration runner.
4. Confirm rows `202607170001` and `202607170002` exist in `support_schema_migrations`.
5. Confirm `support_users.auth_version`, `support_login_rate_limits`, and `support_record_login_failure` exist.
6. Inspect the exact function privileges with `\df+ public.support_record_login_failure` in an approved PostgreSQL client, or run the catalog query below. Verify `PUBLIC`, `anon`, and `authenticated` have no execute privilege and `service_role` does.
7. Confirm the function configuration includes `search_path=pg_catalog, public` and perform an application login-failure smoke test through the deployed server route only.
8. Run `npm run verify:migrations` against the exact deployed source revision.
9. Configure the production environment variables, then deploy the application.

Do not attempt to execute arbitrary SQL through the Supabase REST API. The repository verifier deliberately performs no database mutation.

```sql
select
  p.oid::regprocedure as function_signature,
  p.prosecdef as security_definer,
  p.proconfig as function_configuration,
  coalesce(r.rolname, 'PUBLIC') as grantee,
  privilege_type
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
left join pg_roles r on r.oid = acl.grantee
where n.nspname = 'public'
  and p.oid = 'public.support_record_login_failure(text,timestamptz,integer,integer,integer)'::regprocedure
order by grantee, privilege_type;
```

Expected application-role result: `service_role` has `EXECUTE`; `PUBLIC`, `anon`, and `authenticated` have no row granting `EXECUTE`. The function owner may retain owner privileges. `security_definer` must be true and `function_configuration` must show `search_path=pg_catalog, public`.

## What the migration changes

- Creates `support_schema_migrations` if absent.
- Adds `support_users.auth_version` with a non-destructive default of `1` when `support_users` exists.
- Creates the dedicated persistent login rate-limit table and supporting index.
- Creates an atomic PL/pgSQL function that records a failed login and establishes a lock.
- Enables RLS and grants only the server-side Supabase service role the required access.
- Records the migration version idempotently.

The correction migration is non-destructive. It revokes default and browser-role execution of the existing `SECURITY DEFINER` rate-limit RPC, re-grants execution to `service_role`, pins a trusted function search path, and records `202607170002`. It does not drop or recreate the function or table and does not delete existing login rate-limit state.

No table is dropped, no existing password is reset, and no production data is copied or deleted.

## Rollback considerations

Prefer rolling application code forward. If a rollback is required, redeploy the prior application first. `auth_version` and `support_schema_migrations` can remain safely. Remove the rate-limit function/table only during a controlled maintenance window after confirming no deployed code uses them. Never delete rate-limit state while the hardened login route is active.
