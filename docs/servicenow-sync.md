# ServiceNow Incident synchronization

## Scope

AI-1.1 imports normalized Incident records from the configured ServiceNow PDI into SUPPER's relational ticket store. Runs are manual, bounded, server-only, and read-only toward ServiceNow Incident data. This milestone has no schedule, queue, webhook, attachment/journal ingestion, ServiceNow data write, customer-mapping UI, AI call, email intake change, or production rollout.

Browser code calls only `GET` and `POST /api/integrations/servicenow/sync`. Both require an active SUPPER session with `settings:manage`. The POST body is strict and limited to 4 KiB:

```json
{ "mode": "initial", "dryRun": true }
```

No arbitrary ServiceNow query, field, table, URL, credential, or watermark crosses this API boundary.

## Architecture

The provider-neutral engine in `src/lib/integrations/sync/` owns pagination, bounds, counters, lock lifetime, dry-run behavior, completion status, and watermark rules. ServiceNow-specific normalization, hashing, mapping, repository calls, and orchestration live in `src/lib/integrations/servicenow/sync/`. API handlers do authorization and bounded validation only. React components never import Supabase or ServiceNow credentials.

The ServiceNow client requests the existing Incident allowlist and builds the incremental encoded query internally:

```text
sys_updated_on>=<trusted UTC timestamp>^ORDERBYsys_updated_on^ORDERBYsys_id
```

Only ServiceNow Incident-table `GET` operations exist. Each page retains the configured timeout and caller `AbortSignal`. When OAuth client credentials is selected, the existing AI-1.0 authentication boundary still performs its standard token-endpoint POST; that is an authentication exchange, never an Incident write.

## Relational schema

Migration `supabase/migrations/202607200001_servicenow_incremental_sync.sql` adds:

- `external_ticket_links`: unique `(provider, external_sys_id)` and `(provider, external_number)` links to one `support_tickets` row; stores source timestamps, hash, URL, and bounded metadata.
- `integration_sync_state`: one `servicenow` / `incident` watermark and lock row.
- `integration_sync_runs`: bounded summaries for manual and dry-run attempts.
- `integration_sync_run_items`: committed-run record outcomes only; no raw source records.
- `support_acquire_integration_sync_lock(...)`: atomic acquire, expired takeover, and same-token refresh.
- `support_release_integration_sync_lock(...)`: token-matched release only.
- `support_complete_integration_sync_run(...)`: atomically marks the run successful and advances its owned watermark.
- `support_upsert_servicenow_incident(jsonb)`: bounded atomic ticket/link create or merge.

All new tables have RLS enabled. No anonymous or authenticated policies are added. Table access and RPC execution are granted only to `service_role`; every `SECURITY DEFINER` RPC has an explicit search path and explicit `PUBLIC`, `anon`, and `authenticated` revokes.

## External link and idempotency

`sys_id` is the durable external identity. ServiceNow number is independently unique per provider. One RPC locks the current link and ticket, rejects number conflicts, then creates or merges both records in one transaction. Replaying an overlap record cannot create another ticket or link.

The source hash is SHA-256 over only normalized ServiceNow-owned fields in stable key order. It excludes secrets, raw payloads, provider metadata, sync time, and other volatile values.

Outcome rules:

- `created`: no external link existed and ticket/link were inserted atomically.
- `stale`: source `sys_updated_on` is older than the linked external timestamp.
- `unchanged`: meaningful source fields hash identically; last-seen timestamps may move forward.
- `updated`: source is meaningfully changed and is not stale.
- Equal timestamp with a different hash updates safely and records `SAME_TIMESTAMP_CHANGED`.

## Source ownership matrix

| Field group | Owner | Synchronization behavior |
| --- | --- | --- |
| `issueId`, `issueTitle`, `issueType=Incident` | ServiceNow | Created and updated |
| `category`, `severity`, `status`, `kanbanStatus` | ServiceNow mapping | Created and updated from explicit mapping helpers |
| `date`, `startDate`, `closeDate` | ServiceNow | Created and updated from validated UTC timestamps; relational date columns use `Asia/Bangkok` calendar dates |
| `serviceNow.*`, source URL/hash/reference/timestamp metadata | ServiceNow | Created and updated, bounded by schema and RPC payload size; descriptions are capped at 4,000 characters with a warning |
| Unmapped `customerKey` / `customerName` | ServiceNow pending mapping | May update only while the current key begins `servicenow-unmapped:` |
| Administrator-confirmed customer/project/contract mapping | SUPPER | Always preserved |
| `owner`, `ownerEfforts`, `mdUsed`, `chargeable`, `dueDate` | SUPPER | Always preserved on updates |
| `remark`, `ticketLogs`, `slaPauses`, manual resolution notes | SUPPER | Always preserved |
| Existing unknown operational/AI/billing JSON properties | SUPPER | Preserved because the RPC overlays allowed keys onto existing JSONB rather than replacing it |
| `createdAt` on an existing ticket | SUPPER record lifecycle | Preserved; ServiceNow creation time remains in `serviceNow.externalCreatedAt` |

Every new external ticket is non-chargeable with zero effort and no owner. Synchronization never adds a `support_customers` row.

## Customer handling

An unmapped Incident uses `servicenow-unmapped:<stable-company-id>`. A reference object uses its stable `value` rather than display text. When no company identity exists, the single fallback is `servicenow-unmapped:unknown`. Display text and stable identity remain in bounded `serviceNow` metadata, and `requiresCustomerMapping` is true. Once an administrator maps the ticket to a real customer, future syncs preserve that mapping. Mapping administration is deferred to AI-1.2.

## Explicit mappings

All source records map to canonical issue type `Incident`.

Priority mapping is `1 → Critical`, `2 → High`, `3 → Medium`, and `4/5 → Low`. Display labels are accepted when numeric values are absent. Missing or future values fall back to `Medium` with a bounded warning.

State mapping reuses current SUPPER conventions:

| ServiceNow | SUPPER status | Kanban |
| --- | --- | --- |
| New / 1 | `00 - Open` | `open` |
| In Progress / 2 | `04 - Func Inprogress` | `in_progress` |
| On Hold / 3 | `07 - Waiting user` | `waiting` |
| Resolved / 6 | `08 - Resolved` | `resolved` |
| Closed / 7 | `02 - Closed` | `closed` |
| Cancelled / 8 | `01 - Cancel` | `cancelled` |
| Missing/unknown | `00 - Open` with warning | `open` |

Invalid non-empty timestamps fail that record and are never replaced with the current time. ServiceNow timestamps without an offset use the provider's UTC API convention and are normalized to ISO UTC.

## Initial and incremental modes

Initial mode starts at `now - SERVICENOW_SYNC_INITIAL_LOOKBACK_DAYS`; it never scans the entire Incident table. Incremental mode starts at the latest successful watermark minus `SERVICENOW_SYNC_OVERLAP_SECONDS`. If no successful watermark exists, incremental mode uses the same bounded initial lookback.

Runs stop at configured page/record limits, provider timeout, abort, provider-wide failure, or lock-expiration risk. The configured lock TTL must exceed the provider timeout plus a safety margin; the engine refreshes its own token before page and record work approaches that margin. Reaching a configured bound with a full page produces `partial` and does not pretend the interval completed.

The watermark advances to the greatest valid processed `sys_updated_on` only when a committed run completed the source interval, every record was deterministic, no record failed, and the run still owns the lock. Successful run completion and watermark advancement happen in one database RPC transaction, preventing a checkpoint from reporting success without its run record. It never advances for dry-run, partial, failed, aborted, timed-out, malformed-page, truncated, or lock-lost runs. `last_attempt_at` moves for each committed attempt, including a blocked lock attempt; `last_successful_sync_at` moves only with a successful committed watermark.

## Locking and failure isolation

The state row is also a database-backed lease. Acquisition succeeds for an empty/expired lock or the same refreshing token. Release requires the matching token. Long runs refresh before expiry; loss of ownership prevents watermark advancement. TTL remains the final safety boundary if release fails.

One malformed Incident creates a bounded `failed` run item, processing continues, the run becomes `partial`, and the watermark stays put. Authentication, timeout, connectivity, abort, malformed page shape, or storage failure stops the run. Stored and returned errors contain stable categories/codes only, never provider bodies, stack traces, records, descriptions, credentials, tokens, or headers.

## Dry run

Dry-run validates configuration, observes the current lock without mutating it, fetches and normalizes ServiceNow records, calculates mappings/merge outcomes, and stores one summary marked `dry_run=true`. It does not acquire or modify sync state, write tickets or external links, advance a watermark, create permanent run items, or write the general audit log.

A committed manual run writes one bounded SUPPER audit entry with actor, provider, mode, run ID, status, created/updated/failed counters, watermark, and timestamp. Unchanged records do not create general audit rows.

## Environment

Configure only the isolated `ai_development` Vercel Preview environment:

```dotenv
DATA_BACKEND=supabase-relational
SERVICENOW_ENABLED=true
SERVICENOW_SYNC_ENABLED=false
SERVICENOW_SYNC_INITIAL_LOOKBACK_DAYS=30
SERVICENOW_SYNC_OVERLAP_SECONDS=120
SERVICENOW_SYNC_MAX_RECORDS=1000
SERVICENOW_SYNC_MAX_PAGES=20
SERVICENOW_SYNC_LOCK_TTL_SECONDS=300
```

Bounds are: lookback 1–365 days, overlap 0–900 seconds, records 1–5000, pages 1–100, and lock TTL 30–1800 seconds. Keep synchronization disabled until the AI-development migration is applied and verified. AI-1.0 diagnostic reads remain available while this switch is false.

## Manual migration procedure

This migration must not be applied automatically unless the linked target is proven to be the isolated `supper-ai-dev` project. The source delivery intentionally leaves remote DDL unapplied.

1. In Supabase, open the isolated **supper-ai-dev** project and verify its displayed project ref against the approved AI-development ref. Stop if it is the production project or if the ref is uncertain.
2. Open **SQL Editor → New query** in that verified project.
3. Open local file `supabase/migrations/202607200001_servicenow_incremental_sync.sql` and paste the complete, unchanged SQL into the editor.
4. Review that the script begins with `begin;`, ends with `commit;`, creates only the AI-1.1 tables/functions, and contains no `delete`, `truncate`, or destructive business-data statement.
5. Run once. A safe rerun is idempotent where practical and records migration version `202607200001`.
6. Run the safe acceptance queries below.
7. Add the six sync environment values to the `ai_development` Vercel Preview only, redeploy that branch, verify readiness, then change `SERVICENOW_SYNC_ENABLED=true` and redeploy.

Do not use the service-role REST API for DDL. Do not run the SQL against production.

## Safe SQL acceptance checklist

These queries read schema and bounded operational counts only:

```sql
select version, description, applied_at
from public.support_schema_migrations
where version = '202607200001';

select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('external_ticket_links', 'integration_sync_state', 'integration_sync_runs', 'integration_sync_run_items')
order by table_name;

select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('external_ticket_links', 'integration_sync_state', 'integration_sync_runs', 'integration_sync_run_items')
order by c.relname;

select routine_name, security_type
from information_schema.routines
where routine_schema = 'public'
  and routine_name in ('support_acquire_integration_sync_lock', 'support_release_integration_sync_lock', 'support_complete_integration_sync_run', 'support_upsert_servicenow_incident')
order by routine_name;

select count(*) as ticket_count from public.support_tickets;
select count(*) as external_link_count from public.external_ticket_links;
select provider, stream, watermark_at, last_attempt_at, last_successful_sync_at
from public.integration_sync_state
where provider = 'servicenow' and stream = 'incident';
```

## Manual acceptance

1. Record `select count(*) from public.support_tickets;` before testing.
2. Sign in to the `ai_development` Preview as an administrator and open **Settings → ServiceNow**.
3. Run **Dry Run Initial Sync**. Confirm fetched counters appear and the ticket count and watermark remain unchanged.
4. Run **Run Initial Sync** and confirm. Verify `INC0010001` appears once in `support_tickets` and once in `external_ticket_links`, a successful run exists, and no customer was created.
5. Run **Run Incremental Sync** immediately. Verify the outcome is unchanged and no duplicate exists.
6. Change `INC0010001` short description in the PDI, run incremental again, and verify the same SUPPER ticket ID is updated.
7. Change a SUPPER-owned effort, chargeable, log/note, or confirmed customer field in SUPPER. Change the Incident again and run incremental. Verify external fields update and the SUPPER-owned value remains.
8. Refresh sync status in the card and confirm the latest safe summary and successful timestamp.
9. Review ServiceNow Incident-table network operations and confirm this milestone contains no Incident POST, PATCH, PUT, or DELETE. An OAuth token exchange POST may exist when that authentication mode is configured.

The current PDI uses a dedicated integration user with the temporary `itil` role. Basic auth is limited to isolated PDI development; OAuth client credentials is the hardened direction.

## Rollback and remaining limitations

There is no fake cross-system transaction and no automatic rollback of ServiceNow changes because SUPPER never writes ServiceNow. Do not drop the new tables/functions while sync is enabled or a lease is active. A database rollback would require disabling sync, confirming no active lock, preserving run/link state for audit, and performing a separately reviewed manual migration. Existing tickets are never deleted by this migration or engine.

PDI availability, role breadth, and ServiceNow offset pagination remain development limitations. A run that reaches a bound is intentionally partial. Customer mapping, richer operations history, manual link repair, and lock/run administration belong to AI-1.2 Integration Operations UI.
