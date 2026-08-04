# Database Migrations

Versioned, reviewable SQL migrations live in `supabase/migrations/`. Names use `YYYYMMDDNNNN_description.sql`; an applied migration is immutable and later changes require a new version.

## Verification

`npm run verify:migrations` validates naming, ordering, duplicate versions, empty files, and that application `SECURITY DEFINER` functions have an explicit signature-matched `PUBLIC` revoke. It does not execute SQL and does not contact Supabase.

## Applying Phase 0.2.1

Apply all migrations manually in immutable version order:

1. `supabase/migrations/202607170001_security_foundation.sql`
2. `supabase/migrations/202607170002_security_foundation_corrections.sql`
3. `supabase/migrations/202607180001_fix_login_rate_limit_rpc_conflict.sql`
4. `supabase/migrations/202607180002_fix_login_rate_limit_rpc_variable_conflict.sql`

Use one of these approved paths:

1. Review the complete SQL and its target project.
2. Take the normal database backup or recovery checkpoint.
3. Execute `202607170001`, commit it, then execute `202607170002`, `202607180001`, and `202607180002` in the Supabase SQL Editor while authenticated as an authorized database administrator, or use the organization's approved Supabase migration runner.
4. Confirm rows `202607170001`, `202607170002`, `202607180001`, and `202607180002` exist in `support_schema_migrations`.
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

Migration `202607180001` replaces only the function body to target the table primary-key constraint explicitly. This removes the ambiguous column-name conflict target while retaining the same signature, behavior, search path, grants, and existing rate-limit rows.

Migration `202607180002` pins PL/pgSQL name resolution to table columns inside this function. `RETURNS TABLE` creates output variables named like the stored columns, so the local `#variable_conflict use_column` directive prevents those variables from shadowing insert/update column references without changing the RPC signature or stored state.

No table is dropped, no existing password is reset, and no production data is copied or deleted.

## Rollback considerations

Prefer rolling application code forward. If a rollback is required, redeploy the prior application first. `auth_version` and `support_schema_migrations` can remain safely. Remove the rate-limit function/table only during a controlled maintenance window after confirming no deployed code uses them. Never delete rate-limit state while the hardened login route is active.

## Applying AI-1.3.1 Unified Intake Core corrections

Migration `supabase/migrations/202607220001_unified_intake_core.sql` is immutable. Because its remote application status cannot be proven without connecting to Supabase, AI-1.3.1 uses the new forward-only correction `supabase/migrations/202607220002_unified_intake_core_corrections.sql`. The correction is non-destructive, records version `202607220002`, and may be run again safely. It must be applied only after every earlier migration and only to the verified isolated `supper-ai-dev` Supabase project. Repository automation intentionally does not apply either file remotely.

1. Verify the Supabase project name/ref is the isolated `supper-ai-dev` target and that no production project is linked.
2. Take the normal database backup or recovery checkpoint.
3. Review both complete immutable SQL files at the same Git commit being deployed. If `202607220001` is already recorded, do not run or edit it again; proceed to `202607220002`.
4. Run `npm run verify:migrations`, `npm run verify:architecture`, and `npm run verify:intake-core-sql` locally. The last command creates and deletes an isolated PostgreSQL cluster under `/tmp`; it never contacts Supabase.
5. If absent, paste and execute the complete `202607220001_unified_intake_core.sql` first. Then paste and execute the complete `202607220002_unified_intake_core_corrections.sql`. Never concatenate, partially copy, or edit an applied migration.
6. Confirm `support_schema_migrations` contains both `202607220001` and `202607220002`.
7. Confirm all intake tables, including `intake_conversation_events` and `intake_session_events`, have RLS enabled. Confirm `PUBLIC`, `anon`, and `authenticated` have no table privileges or RPC execution grant; `service_role` must retain the documented access.
8. Deploy the exact `ai_development` Preview commit and run the manual diagnostic acceptance in [Unified Intake Core](unified-intake-core.md).

```sql
select version, description
from public.support_schema_migrations
where version in ('202607220001', '202607220002')
order by version;

select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname like any (array['integration_%', 'intake_%'])
order by relname;

select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in (
    'support_get_intake_operations_summary',
    'support_list_intake_identities',
    'support_list_intake_conversations',
    'support_list_intake_events',
    'support_accept_intake_event',
    'support_apply_intake_identity_binding',
    'support_revoke_intake_identity_binding',
    'support_transition_intake_session',
    'support_transition_intake_conversation',
    'support_enqueue_integration_outbox'
  )
order by routine_name, grantee;
```

Expected: two ordered migration rows, RLS true for every listed intake table, `service_role` execution grants, and no `PUBLIC`, `anon`, or `authenticated` execution grant.

The correction adds canonical event/message/attachment verification, recursive credential-key rejection, strict metadata allowlists, bounded read-model RPCs, scoped advisory locking, accepted-event redelivery counters, append-only Conversation/Session history, Conversation compare-and-swap transitions, validation-before-cast helpers, and truthful existing-outbox status. It does not move or delete intake rows, call a provider, create a Ticket, add attachment bytes, or start a worker.

Do not use REST/service-role endpoints for DDL. Do not run this migration against production as part of AI-1.3 acceptance. Roll application code forward if a problem is found; do not delete intake rows or drop the new tables casually.

## Applying AI-1.3.2 replay corrections

Migrations `202607220001` and `202607220002` remain immutable. Hosted Supabase commonly installs `pgcrypto` in the `extensions` schema rather than `public`; intake hashing therefore routes through the internal `support_intake_sha256_hex(text)` helper whose controlled search path supports either layout. Do not relocate the extension, change Supabase-managed ownership, or add a `public.digest` wrapper.

The isolated `supper-ai-dev` migration ledger was explicitly verified to contain `202607220001` and `202607220002` only. The first attempt to apply `202607220003` failed transactionally before commit, and `202607220004` had never been attempted, so these two unapplied source migrations were amended for schema portability. No already-applied migration was rewritten. After successful application, treat both files as immutable.

Apply the forward-only, idempotent `supabase/migrations/202607220003_unified_intake_core_replay_corrections.sql` only to the verified isolated `supper-ai-dev` project. It records version `202607220003`, backfills immutable Attachment source hashes and initial delivery rows without deleting intake state, and adds service-role-only v2 RPCs. Repository verification uses a disposable local PostgreSQL cluster with `pgcrypto` installed in `extensions`; it never connects to Supabase.

1. Confirm the selected project name/ref is `supper-ai-dev`, not production, and take the normal recovery checkpoint.
2. Deploy no application code yet. Run `npm ci`, the full test/lint/build suite, `npm run verify:migrations`, and `npm run verify:intake-core-sql` from the exact commit. The SQL verifier uses a disposable local PostgreSQL cluster.
3. Confirm migration rows `202607220001` and `202607220002` exist. If either is absent, stop and follow the prior section in order; never edit or replay an already-applied immutable file.
4. In the isolated project's SQL editor, paste and execute the complete unmodified `202607220003_unified_intake_core_replay_corrections.sql` once. Do not concatenate it with another migration or use a REST endpoint for DDL.
5. Run the checks below. Confirm three ordered versions; RLS on `intake_event_deliveries`; no browser-role grants; `service_role` execution on every v2 RPC; and no null Attachment source hash.
6. Deploy the exact `ai_development` commit to Vercel Preview and execute the smoke tests in [Unified Intake Core](unified-intake-core.md). Do not merge to `main` during this acceptance.

```sql
select version, description
from public.support_schema_migrations
where version in ('202607220001', '202607220002', '202607220003')
order by version;

select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('intake_attachments', 'intake_events', 'intake_event_deliveries')
order by relname;

select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in (
    'support_accept_intake_event_v2',
    'support_apply_intake_identity_binding_v2',
    'support_transition_intake_conversation_v2',
    'support_enqueue_integration_outbox_v2'
  )
order by routine_name, grantee;

select count(*) as attachments_missing_source_hash
from public.intake_attachments
where source_material_hash is null;
```

Expected: versions `202607220001`, `202607220002`, and `202607220003`; RLS true; only `service_role` has v2 execution; and `attachments_missing_source_hash=0`. Roll application behavior forward if correction is needed. Do not drop the delivery ledger, overwrite source hashes, or delete replay state.

## Applying AI-1.3.3 final integrity corrections

Migrations `202607220001` and `202607220002` are immutable. As documented above, `202607220003` and `202607220004` were amended only while both remained unapplied on the verified isolated target. Migration 004 gives the renamed migration-002 write implementation the controlled `pg_catalog, public, extensions, pg_temp` search path because that preserved function body still contains its original unqualified pgcrypto calls.

Apply the forward-only, idempotent `supabase/migrations/202607220004_unified_intake_core_final_integrity.sql` only to the verified isolated `supper-ai-dev` project. It records version `202607220004`, preserves existing intake rows and lifecycle state, routes legacy/v2/v3 Event acceptance through one lock coordinator, rejects duplicate Attachment identities, protects both immutable Attachment hashes, verifies persisted Message reconstruction before commit, and records current delivery request context without a table trigger.

1. Confirm the project name/ref is exactly the isolated `supper-ai-dev` target, never production, and take the normal recovery checkpoint.
2. From the exact `ai_development` commit run the complete acceptance command set, especially `npm run verify:migrations` and `npm run verify:intake-core-sql`. The SQL verifier builds representative 1.3.1 state under migration 002 before applying 003 and 004, then reapplies both corrections.
3. Confirm migration rows `202607220001` through `202607220003` exist. If one is absent, stop and apply the immutable files in order; never modify an already-applied file.
4. In the isolated project's SQL editor, paste and execute the complete unmodified `202607220004_unified_intake_core_final_integrity.sql` once. Do not concatenate migrations or apply DDL through REST.
5. Run the verification SQL below. Confirm four ordered versions, equal valid Attachment hashes, no legacy Event delivery trigger, service-role execution only on public acceptance RPCs, and no direct grant on private implementations.
6. Deploy the exact commit to Vercel Preview and run the manual smoke test in [Unified Intake Core](unified-intake-core.md). Do not merge to `main` during acceptance.

```sql
select version, description
from public.support_schema_migrations
where version in ('202607220001', '202607220002', '202607220003', '202607220004')
order by version;

select count(*) as attachment_hash_integrity_failures
from public.intake_attachments
where source_material_hash !~ '^[a-f0-9]{64}$'
   or canonical_hash !~ '^[a-f0-9]{64}$'
   or source_material_hash <> canonical_hash;

select count(*) as legacy_delivery_triggers
from pg_trigger
where tgrelid = 'public.intake_events'::regclass
  and tgname = 'support_intake_event_delivery_ledger'
  and not tgisinternal;

select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in (
    'support_accept_intake_event',
    'support_accept_intake_event_v2',
    'support_accept_intake_event_v3',
    'support_accept_intake_event_final_impl',
    'support_accept_intake_event_locked_write_impl'
  )
order by routine_name, grantee;
```

Expected: versions `202607220001` through `202607220004`; `attachment_hash_integrity_failures=0`; `legacy_delivery_triggers=0`; only `service_role` can execute the three public acceptance RPC generations; neither private implementation is directly executable. No table is dropped, no intake row or lifecycle state is deleted, and no provider operation is performed.

## Applying AI-2.0.9 ServiceNow write kernel

Migration `202607230001_servicenow_write_kernel.sql` was amended before first remote application. Evidence from the audited development sequence showed the migration was created locally, remote execution was explicitly deferred, and no remote SQL command applied it. If version `202607230001` is already present on a target, stop and create a reviewed forward-only correction instead of running this amended file.

The migration records version `202607230001`, creates eight RLS-protected `servicenow_write_*` tables plus the controlled Ticket-link table, and exposes validated configuration, mapping, readiness, command, confirmation, Attempt, recovery, and reconciliation RPCs. AI-2.0.9 adds strict reusable JSON scalar validators, null-safe exact proof comparisons, G1/G2 and create-reconciliation marker binding, exact non-create provider success evidence, and a database-owned worst-case OAuth/provider request budget plus grace. It rejects every late terminal outcome after recovery and keeps terminal candidate projection independent of display limits. It was amended in place only because explicit delivery history proves this version has never been remotely applied and this correction forbids remote application before review. `service_role` can select ledger rows but cannot directly mutate them. The migration contains no credentials, does not alter existing intake or read-side synchronization rows, and performs no ServiceNow request.

1. Confirm versions `202607220001` through `202607220004` are present, confirm `202607230001` is absent, and take the normal dev recovery checkpoint.
2. From the exact source revision run the full acceptance suite, including `npm run verify:migrations`, `npm run verify:architecture`, and `npm run verify:servicenow-write-sql`.
3. In the isolated dev SQL Editor, paste and execute the complete unmodified migration once. Do not concatenate it with another migration, apply it through REST, or target production.
4. Confirm version `202607230001`, RLS on all write tables, select-only table grants for `service_role`, append-only candidate/recovery enforcement, and privileged RPC execution only for `service_role`, including `support_record_servicenow_write_readiness(jsonb)` and `support_recover_servicenow_write_attempt(jsonb)`.
5. Deploy the exact `ai_development` revision with live writes disabled and follow the smoke sequence in [Controlled ServiceNow Write Kernel](servicenow-write-kernel.md).

After application this migration is immutable. If any target already contains version `202607230001`, do not run the amended file; create a reviewed forward-only `202607230002` correction. Never drop command, attempt, Ticket-link, or reconciliation history as a rollback mechanism. Full verification queries, evidence matrix, and Preview smoke steps are in [Controlled ServiceNow Write Kernel](servicenow-write-kernel.md).
