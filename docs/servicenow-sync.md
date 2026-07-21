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

The ServiceNow client requests the existing Incident allowlist and builds a fixed-window encoded query internally. The first page is inclusive at the lower bound:

```text
sys_updated_on>=<windowStart>^sys_updated_on<=<windowEnd>^ORDERBYsys_updated_on^ORDERBYsys_id
```

Later pages use a composite cursor and an internally generated bounded `NQ` branch equivalent to `sys_updated_on > cursorUpdatedAt OR (sys_updated_on = cursorUpdatedAt AND sys_id > cursorSysId)`. Every branch repeats the fixed upper bound. The persistent path never sends `sysparm_offset`; browser callers cannot supply a cursor or window. AI-1.0 diagnostic sample reads retain their independent bounded offset behavior.

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

Forward-only correction `supabase/migrations/202607200002_servicenow_sync_reliability_corrections.sql` adds `watermark_sys_id`, run-level composite cursor fields, and `window_start_at` / `window_end_at`. It replaces the two existing RPC bodies without changing their signatures: successful completion persists the composite cursor, while Incident upsert performs historical-ticket reconciliation and dry-run decisions through the same database function. The original migration was not edited because its remote application state could not be proven.

All new tables have RLS enabled. No anonymous or authenticated policies are added. Table access and RPC execution are granted only to `service_role`; every `SECURITY DEFINER` RPC has an explicit search path and explicit `PUBLIC`, `anon`, and `authenticated` revokes.

## External link and idempotency

`sys_id` is the durable external identity. ServiceNow number is independently unique per provider. One RPC serializes committed reconciliation with transaction-scoped advisory locks, locks affected rows, rejects conflicts, then creates or merges the ticket and link in one transaction. Replaying an overlap record cannot create another ticket or link.

When no `sys_id` link exists, the RPC checks the ServiceNow number link and `support_tickets.issue_id`. A historical Excel ticket with the same Incident number is adopted: its ID is retained, only ServiceNow-owned fields are overlaid, and a link is created with outcome `updated` and warning `ADOPTED_EXISTING_TICKET`. It never deletes or recreates the ticket. A number linked to another `sys_id`, a `sys_id` paired with another number, a missing linked ticket, or a historical ticket already linked to an incompatible provider/record returns a bounded failed decision and performs no ticket/link write.

The meaningful source hash is SHA-256 over normalized ServiceNow-owned business fields in stable key order. It excludes `sys_updated_on` / `lastUpdatedAt`, secrets, raw payloads, sync/seen timestamps, run IDs, cursors, watermarks, and transport metadata. A timestamp-only ServiceNow touch is therefore `unchanged`: the external link advances `external_updated_at`, `last_seen_at`, and `last_synced_at`, but the ticket JSON (including bounded `serviceNow.externalUpdatedAt`) is not rewritten. The next meaningful update refreshes ticket ServiceNow metadata.

Outcome rules:

- `created`: no external link or matching historical ticket existed and ticket/link were inserted atomically.
- `updated` with `ADOPTED_EXISTING_TICKET`: a compatible historical ticket was linked without replacing its ID or SUPPER-owned data.
- `stale`: source `sys_updated_on` is older than the linked external timestamp.
- `unchanged`: meaningful source fields hash identically; link observation/source timestamps may move forward without a ticket rewrite.
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

Initial mode captures `windowStart = runStart - SERVICENOW_SYNC_INITIAL_LOOKBACK_DAYS` and a fixed `windowEnd = trusted runStart`; it never scans the entire Incident table. Incremental mode uses the latest successful `(watermark_at, watermark_sys_id)` cursor and subtracts the overlap from the time lower bound. With overlap, the lower interval is deliberately replayed; with zero overlap, the stored composite cursor is exclusive. If a legacy state has no `watermark_sys_id`, the timestamp boundary is replayed inclusively rather than risking a skip.

Every page is ordered by `sys_updated_on`, then `sys_id`, and starts strictly after the previous page cursor. Records updated after the fixed `windowEnd` belong to the next run, so provider mutation cannot shift offsets and skip another record. Page cursors must be strictly increasing and remain inside the source window; otherwise the run fails safely without advancing the durable cursor.

Runs stop at configured page/record limits, provider timeout, abort, provider-wide failure, or lock-expiration risk. The configured lock TTL must exceed the provider timeout plus a safety margin; the engine refreshes its own token before page and record work approaches that margin. Reaching a configured bound with a full page produces `partial` and does not pretend the interval completed.

The composite watermark advances to the greatest processed `(sys_updated_on, sys_id)` only when a committed run completed the fixed source interval, every record was deterministic, no record failed, and the run still owns the lock. Successful run completion and cursor advancement happen in one database RPC transaction. It never advances for dry-run, partial, failed, aborted, timed-out, malformed-page, truncated, or lock-lost runs. `last_attempt_at` moves for each committed attempt, including a blocked lock attempt; `last_successful_sync_at` moves only with successful completion.

## Locking and failure isolation

The state row is also a database-backed lease. Acquisition succeeds for an empty/expired lock or the same refreshing token. Release requires the matching token. Long runs refresh before expiry; loss of ownership prevents watermark advancement. TTL remains the final safety boundary if release fails.

One malformed Incident creates a bounded `failed` run item, processing continues, the run becomes `partial` with `record_failures`, and the watermark stays put. A configured page/record bound before interval completion is `partial` / `bounded_truncation`; unavailable lock is `blocked` / `lock_conflict`; lost lock is `failed` / `lock_lost`. Authentication, timeout, connectivity, abort, malformed page shape/cursor, or storage failure stops the run. Stored and returned errors contain stable categories/codes only, never provider bodies, stack traces, records, descriptions, credentials, tokens, or headers.

## Dry run

Dry-run validates configuration, observes the current lock without mutating it, fetches/normalizes records, and calls the same reconciliation RPC with `dryRun=true`. The RPC inspects links by `sys_id` and number plus the canonical `issue_id`, so created/adopted/unchanged/stale/conflict categories match commit behavior. It stores one summary marked `dry_run=true`, but does not acquire or modify sync state, write tickets/links, advance a watermark, create run items, or write the general audit log.

`integration_sync_runs` is the authoritative durable run audit and `integration_sync_run_items` is authoritative per-record traceability. A committed manual run additionally attempts one bounded, human-facing `support_audit_log` entry. That secondary write is best-effort: failure never changes a committed synchronization result, emits a safe critical server event, attempts to set `metadata.auditWriteFailed=true`, and exposes only `secondary_audit_write_failed` in status responses. Unchanged records do not create general audit rows.

## Customer-mapping replay semantics

The AI-1.2.1 wrapper uses the same customer identity precedence as TypeScript: explicit ServiceNow external key, relational deterministic unmapped key, `externalCustomerId`, then legacy `companyExternalId`. Active mapping metadata is restored after meaningful base updates, but `customerMappingAppliedAt` always remains the canonical millisecond UTC time of the latest explicit mapping create/change/reactivation. It is never replaced by the synchronization time.

An identical fully mapped replay returns the base `unchanged` outcome and does not update `support_tickets.data`, relational `updated_at`, Ticket `updatedAt`, mapping-applied time, mapping row, mapping event, or general mapping audit. External-link observation timestamps retain accepted AI-1.1 behavior. When title, state, or priority changes, the ServiceNow-owned field changes while customer assignment, mapping ID/time, and SUPPER-owned fields remain intact.

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

These migrations must not be applied automatically unless the linked target is proven to be the isolated `supper-ai-dev` project. Remote application of `202607200001` could not be proven during AI-1.1.1, so the original file remains immutable and the source delivery adds forward-only correction `202607200002`. Remote DDL remains intentionally unapplied.

1. In Supabase, open the isolated **supper-ai-dev** project and verify its displayed project ref against the approved AI-development ref. Stop if it is the production project or if the ref is uncertain.
2. Open **SQL Editor → New query** in that verified project.
3. Run the first safe query below to check `support_schema_migrations` for versions `202607200001` and `202607200002`.
4. If `202607200001` is absent, paste and run the complete unchanged `supabase/migrations/202607200001_servicenow_incremental_sync.sql` first. If it is present, do not rerun or edit it.
5. Paste and run the complete unchanged `supabase/migrations/202607200002_servicenow_sync_reliability_corrections.sql` after `202607200001` exists.
6. Review each script starts with `begin;`, ends with `commit;`, and contains no ticket/link deletion, truncation, or destructive business-data statement.
7. Run the full safe acceptance checklist. Version `202607200002` must exist and `watermark_sys_id` / fixed-window columns must be visible.
8. Add the six sync environment values to the `ai_development` Vercel Preview only, redeploy, verify readiness, then change `SERVICENOW_SYNC_ENABLED=true` and redeploy.

Do not use the service-role REST API for DDL. Do not run the SQL against production.

## Safe SQL acceptance checklist

These queries read schema and bounded operational counts only:

```sql
select version, description, applied_at
from public.support_schema_migrations
where version in ('202607200001', '202607200002')
order by version;

select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and ((table_name = 'integration_sync_state' and column_name = 'watermark_sys_id')
    or (table_name = 'integration_sync_runs' and column_name in ('watermark_from_sys_id', 'watermark_to_sys_id', 'window_start_at', 'window_end_at')))
order by table_name, column_name;

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
select provider, stream, watermark_at, watermark_sys_id, last_attempt_at, last_successful_sync_at
from public.integration_sync_state
where provider = 'servicenow' and stream = 'incident';
```

## Manual acceptance

1. Create or retain a historical SUPPER ticket whose `issue_id` is `INC0010001`; record its ID and set representative owner/effort, MD, chargeable/non-charge reason, project/customer mapping, manual note/log, and optional AI/unknown JSON values.
2. Record bounded counts for `support_tickets` and `external_ticket_links`, then sign in to the `ai_development` Preview as administrator and open **Settings → ServiceNow**.
3. Run **Dry Run Initial Sync**. Confirm `INC0010001` is `updated` with adopted warning rather than created, while ticket/link counts and watermark remain unchanged.
4. Run **Run Initial Sync**. Confirm the recorded historical ticket ID remains, exactly one ServiceNow link is created, no duplicate ticket/customer exists, and every SUPPER-owned test value remains.
5. Run **Run Incremental Sync** immediately. Confirm `unchanged`, the composite `(watermark_at, watermark_sys_id)` is present, and no duplicate exists.
6. Cause a timestamp-only provider touch without changing imported business fields. Run incremental and confirm `unchanged`; the link `external_updated_at` advances while ticket JSON/manual data does not change.
7. Change the Incident short description. Run incremental and confirm `updated`, same ticket/link IDs, and preserved SUPPER fields.
8. Create multiple PDI records sharing `sys_updated_on` around one page boundary and mutate an earlier record after page one. Confirm each source-window record is processed once, after-window changes defer, and overlap replay creates no duplicates.
9. Trigger two committed runs concurrently. Confirm one proceeds and one is `blocked` / `lock_conflict`.
10. Confirm UI notifications: succeeded is success; partial/blocked are warning; failed is error. If secondary audit is unavailable, confirm the committed result remains and only the sanitized audit warning appears.
11. Review Incident-table network operations and confirm no Incident POST, PATCH, PUT, or DELETE exists. OAuth token exchange POST may exist for authentication only.

The current PDI uses a dedicated integration user with the temporary `itil` role. Basic auth is limited to isolated PDI development; OAuth client credentials is the hardened direction.

## Rollback and remaining limitations

There is no fake cross-system transaction and no automatic rollback of ServiceNow changes because SUPPER never writes ServiceNow. Do not drop the new tables/functions while sync is enabled or a lease is active. A database rollback would require disabling sync, confirming no active lock, preserving run/link state for audit, and performing a separately reviewed manual migration. Existing tickets are never deleted by this migration or engine.

PDI availability and temporary role breadth remain development limitations. Persistent synchronization no longer uses mutable offset pagination; the diagnostic sample reader still uses bounded offsets by design. A run that reaches a bound is intentionally partial. AI-1.2 now provides bounded run inspection and stable company-to-customer mapping; see [ServiceNow operations](./servicenow-operations.md) and [ServiceNow customer mapping](./servicenow-customer-mapping.md). Manual link repair and lock administration remain out of scope.

After AI-1.2.1 acceptance, development proceeds to **AI-1.3 Unified Intake, Identity, Message, and File Core**. LINE OA integration remains deferred until that provider-neutral foundation is accepted.
