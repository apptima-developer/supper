# SUPPER Phase 01 — Database Storage Forensics

Analysis date: **2026-10-15, Asia/Bangkok**. Recovery baseline: DATABASE_RECOVERY_PASS. Analysis completed; no Phase 02/03 implementation was started.

## Decision

**The storage problem is unbounded full-dataset JSON snapshots, rather than the number of operational tickets.** public.app_store occupies **99.2984%** of this restored database. Its **6,085 backup snapshots** contain **1,381.215 MiB of stored JSON**, versus **3.832 MiB** across all 17 current JSON keys. Snapshots account for **99.7233% of stored JSON bytes**.

There are **828 closed tickets older than 90 days by closeDate**, with approximately **1.853 MiB of compact logical ticket/history/audit JSON**, **0.296 MiB gzip**, and only approximately **0.99 MiB of proportional stored-payload savings**. Ticket archival alone cannot get a 1.42 GiB database under a 500 MB quota. Preserve all business records while first designing external snapshot retention and changing the writer that creates these copies.

Moving most snapshots outside the database could avoid approximately **1.35–1.42 GiB of compacted physical storage**; this is an estimate, not already reclaimed space. A hosted footprint of roughly **80–120 MiB** is a planning estimate with bounded snapshots and a small search index, not a measured restored database. Supabase Free is plausible for this workload only after snapshot growth is controlled.

## Scope, safety and measurement method

- Database: supper_restore, PostgreSQL 17.6, container supper-recovery-pg17; published endpoint 127.0.0.1:5433. Only this recovered local database was queried.
- Database files remain under /Volumes/Vault/storage/supper; Docker disk under /Volumes/Vault/storage/docker.
- Every analysis connection used `PGOPTIONS=-c default_transaction_read_only=on`, explicit `BEGIN READ ONLY`, and SELECT-only queries. Session settings only controlled timeouts and timezone. No data/schema modification, cleanup, maintenance command, archive export, application execution or production access occurred.
- All 42 user/service tables were counted exactly. Sizes are PostgreSQL physical relation sizes. MiB = 1,048,576 bytes; GiB = 1,073,741,824 bytes. Quota scenarios conservatively interpret the vendor's 500 MB as 500,000,000 bytes.
- Each table reconciles exactly as main heap + heap auxiliary forks + total TOAST relation + ordinary indexes = total. TOAST total includes its heap, indexes and auxiliary forks; its indexes must not be counted twice.
- Database size: **1,521,888,403 bytes = 1,451.386 MiB = 1.417369 GiB**. Final guard returned the same size and 6,102 app_store rows with read-only mode on. Recovery baseline counts (1,328 tickets, 1,109 closed, 30 customers) are unchanged.
- JSON logical sizes mean UTF-8 text bytes, not disk allocation. `pg_column_size(value)` measures stored JSON payload, which may already be TOAST-compressed; it excludes relation/chunk/index overhead. Compression tests used in-memory buffers only; no historical payload archive was produced.
- Catalog/statistics reads and normal PostgreSQL background bookkeeping are distinct from business writes. The fresh restore cannot reveal dead tuples that existed in production before the dump.

## 1. Complete physical storage breakdown

| Component | Bytes | MiB | Database share |
| --- | ---: | ---: | ---: |
| All 42 main heaps | 966,656 | 0.922 | 0.06352% |
| Main heap auxiliary forks | 32,768 | 0.031 | 0.00215% |
| All table TOAST, including TOAST indexes | 1,509,867,520 | 1,439.922 | 99.21013% |
| Ordinary table indexes, excluding TOAST indexes | 1,925,120 | 1.836 | 0.12650% |
| Catalogs and remaining database allocation, by subtraction | 9,096,339 | 8.675 | 0.59770% |
| **Database total** | **1,521,888,403** | **1,451.386** | **100%** |

Inside the TOAST component, heap data is **1,423.586 MiB** and TOAST indexes are **15.922 MiB**; the rest is auxiliary allocation. All ordinary plus TOAST indexes total **17.758 MiB**, so indexes are a small secondary component, not the root cause.

All 42 tables, sorted by total physical size. Rows are exact; main heap excludes TOAST and indexes. The Aux column makes the decomposition explicit. Percentages use the whole database, including catalog overhead, as denominator.

| Schema.table | Exact rows | Heap MiB | Aux MiB | TOAST MiB | Index MiB | Total MiB | Database % |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| public.app_store | 6,102 | 0.883 | 0.031 | 1,439.641 | 0.648 | 1,441.203 | 99.29841% |
| auth.users | 0 | 0.000 | 0.000 | 0.008 | 0.117 | 0.125 | 0.00861% |
| auth.one_time_tokens | 0 | 0.000 | 0.000 | 0.008 | 0.078 | 0.086 | 0.00592% |
| auth.scim_users | 0 | 0.000 | 0.000 | 0.008 | 0.078 | 0.086 | 0.00592% |
| storage.objects | 0 | 0.000 | 0.000 | 0.008 | 0.062 | 0.070 | 0.00484% |
| auth.refresh_tokens | 0 | 0.000 | 0.000 | 0.008 | 0.055 | 0.062 | 0.00431% |
| auth.custom_oauth_providers | 0 | 0.000 | 0.000 | 0.008 | 0.047 | 0.055 | 0.00377% |
| auth.mfa_factors | 0 | 0.000 | 0.000 | 0.008 | 0.047 | 0.055 | 0.00377% |
| auth.oauth_consents | 0 | 0.000 | 0.000 | 0.008 | 0.039 | 0.047 | 0.00323% |
| auth.scim_tokens | 0 | 0.000 | 0.000 | 0.008 | 0.039 | 0.047 | 0.00323% |
| auth.sessions | 0 | 0.000 | 0.000 | 0.008 | 0.039 | 0.047 | 0.00323% |
| auth.flow_state | 0 | 0.000 | 0.000 | 0.008 | 0.031 | 0.039 | 0.00269% |
| auth.identities | 0 | 0.000 | 0.000 | 0.008 | 0.031 | 0.039 | 0.00269% |
| auth.oauth_authorizations | 0 | 0.000 | 0.000 | 0.008 | 0.031 | 0.039 | 0.00269% |
| auth.saml_relay_states | 0 | 0.000 | 0.000 | 0.008 | 0.031 | 0.039 | 0.00269% |
| public.support_login_rate_limits | 1 | 0.008 | 0.000 | 0.008 | 0.023 | 0.039 | 0.00269% |
| storage.migrations | 73 | 0.008 | 0.000 | 0.000 | 0.031 | 0.039 | 0.00269% |
| auth.saml_providers | 0 | 0.000 | 0.000 | 0.008 | 0.023 | 0.031 | 0.00215% |
| auth.sso_domains | 0 | 0.000 | 0.000 | 0.008 | 0.023 | 0.031 | 0.00215% |
| auth.sso_providers | 0 | 0.000 | 0.000 | 0.008 | 0.023 | 0.031 | 0.00215% |
| auth.webauthn_challenges | 0 | 0.000 | 0.000 | 0.008 | 0.023 | 0.031 | 0.00215% |
| auth.webauthn_credentials | 0 | 0.000 | 0.000 | 0.008 | 0.023 | 0.031 | 0.00215% |
| public.support_schema_migrations | 4 | 0.008 | 0.000 | 0.008 | 0.016 | 0.031 | 0.00215% |
| realtime.subscription | 0 | 0.000 | 0.000 | 0.008 | 0.023 | 0.031 | 0.00215% |
| auth.audit_log_entries | 0 | 0.000 | 0.000 | 0.008 | 0.016 | 0.023 | 0.00161% |
| auth.mfa_amr_claims | 0 | 0.000 | 0.000 | 0.008 | 0.016 | 0.023 | 0.00161% |
| auth.mfa_challenges | 0 | 0.000 | 0.000 | 0.008 | 0.016 | 0.023 | 0.00161% |
| auth.mfa_recovery_code_sets | 0 | 0.000 | 0.000 | 0.000 | 0.023 | 0.023 | 0.00161% |
| auth.mfa_recovery_codes | 0 | 0.000 | 0.000 | 0.008 | 0.016 | 0.023 | 0.00161% |
| auth.oauth_client_states | 0 | 0.000 | 0.000 | 0.008 | 0.016 | 0.023 | 0.00161% |
| auth.oauth_clients | 0 | 0.000 | 0.000 | 0.008 | 0.016 | 0.023 | 0.00161% |
| auth.schema_migrations | 82 | 0.008 | 0.000 | 0.000 | 0.016 | 0.023 | 0.00161% |
| realtime.schema_migrations | 81 | 0.008 | 0.000 | 0.000 | 0.016 | 0.023 | 0.00161% |
| storage.buckets | 0 | 0.000 | 0.000 | 0.008 | 0.016 | 0.023 | 0.00161% |
| storage.buckets_analytics | 0 | 0.000 | 0.000 | 0.008 | 0.016 | 0.023 | 0.00161% |
| storage.s3_multipart_uploads | 0 | 0.000 | 0.000 | 0.008 | 0.016 | 0.023 | 0.00161% |
| storage.vector_indexes | 0 | 0.000 | 0.000 | 0.008 | 0.016 | 0.023 | 0.00161% |
| vault.secrets | 0 | 0.000 | 0.000 | 0.008 | 0.016 | 0.023 | 0.00161% |
| auth.instances | 0 | 0.000 | 0.000 | 0.008 | 0.008 | 0.016 | 0.00108% |
| storage.buckets_vectors | 0 | 0.000 | 0.000 | 0.008 | 0.008 | 0.016 | 0.00108% |
| storage.s3_multipart_uploads_parts | 0 | 0.000 | 0.000 | 0.008 | 0.008 | 0.016 | 0.00108% |
| realtime.messages | 0 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.00000% |

## 2. Top ten largest tables and actual application purpose

| Rank | Table | Rows | Total MiB | Purpose in this recovery |
| ---: | --- | ---: | ---: | --- |
| 1 | public.app_store | 6,102 | 1,441.203 | Actual SUPPER storage: current ticket/customer/history/audit/master/user/import/report JSON and automatic full-dataset backup snapshots. Repositories map these JSON keys, not separate ticket tables. |
| 2 | auth.users | 0 | 0.125 | Supabase Auth user records. Empty here; SUPPER custom login reads auth/users.json in app_store instead. |
| 3 | auth.one_time_tokens | 0 | 0.086 | Supabase Auth one-time-token service metadata; empty and unused by the inspected custom login. |
| 4 | auth.scim_users | 0 | 0.086 | Supabase Auth SCIM provisioning mappings; empty; no SUPPER repository references it. |
| 5 | storage.objects | 0 | 0.070 | Supabase Storage object metadata; empty. Actual SUPPER inline ticket attachments are in JSON, not this table. |
| 6 | auth.refresh_tokens | 0 | 0.062 | Supabase Auth refresh-token service metadata; empty. SUPPER signs its own session JWT with jose. |
| 7 | auth.custom_oauth_providers | 0 | 0.055 | Supabase Auth provider configuration; empty; no application dependency found. |
| 8 | auth.mfa_factors | 0 | 0.055 | Supabase Auth MFA factor metadata; empty; not used by the inspected login path. |
| 9 | auth.oauth_consents | 0 | 0.047 | Supabase Auth OAuth consent metadata; empty; no SUPPER repository references it. |
| 10 | auth.scim_tokens | 0 | 0.047 | Supabase Auth SCIM credential metadata; empty; no application dependency found. |

Service-table purposes are inferred from their actual schema/column identities; the source proves that these are not SUPPER's business repositories. Source evidence: [repositories.ts](../../src/lib/repositories.ts), [store.ts](../../src/lib/store.ts), [auth.ts](../../src/lib/auth.ts), [types.ts](../../src/lib/types.ts), and [report-storage.ts](../../src/lib/report-storage.ts). auth.users contains zero rows, whereas the actual application auth/users.json contains 14 users. The nine smaller tables appear in the top ten largely because they have preallocated indexes even when empty; they are not useful archival targets for savings.

## 3. Excessive storage: JSON snapshot amplification

### Measured snapshot content

| Snapshot target | Rows | Stored MiB | Logical text MiB | Distinct content hashes | Duplicate excess rows |
| --- | ---: | ---: | ---: | ---: | ---: |
| backups/core/tickets.json | 1,539 | 596.492 | 1,906.868 | 1,533 | 6 |
| backups/core/ticket-history.json | 1,084 | 430.598 | 1,346.529 | 1,077 | 7 |
| backups/audit/audit-log.json | 1,683 | 344.895 | 1,179.066 | 1,680 | 3 |
| backups/core/customers.json | 1,709 | 9.162 | 30.154 | 1,703 | 6 |
| backups/auth/users.json | 13 | 0.019 | 0.026 | 13 | 0 |
| backups/master/sla.json | 9 | 0.012 | 0.009 | 7 | 2 |
| backups/imports/import-batches.json | 5 | 0.011 | 0.017 | 5 | 0 |
| backups/master/teams.json | 10 | 0.010 | 0.013 | 7 | 3 |
| backups/master/statuses.json | 5 | 0.005 | 0.005 | 2 | 3 |
| backups/master/categories.json | 5 | 0.004 | 0.004 | 5 | 0 |
| backups/reports/report-jobs.json | 5 | 0.003 | 0.003 | 5 | 0 |
| backups/master/issue-types.json | 6 | 0.001 | 0.001 | 3 | 3 |
| backups/master/priorities.json | 6 | 0.001 | 0.001 | 3 | 3 |
| backups/master/contract-types.json | 6 | 0.001 | 0.001 | 3 | 3 |

Total snapshot logical text: **4,679,476,283 bytes (4.358 GiB)**. Ticket snapshots, history snapshots and audit snapshots dominate; small import metadata and master lists do not.

Only **39 excess rows** have content hashes identical to another snapshot of the same target, representing **11.377 MiB**. This uses MD5 grouping over canonical jsonb text as a practical duplicate screen, not a deletion proof or integrity checksum. Most snapshots differ slightly, so deleting only exact duplicates would barely help. The dominant redundancy is copying almost-identical full arrays on every edit.

Source evidence:

- [json-store.ts:85](../../src/lib/json-store.ts#L85): writeJsonAtomic reads the previous full JSON value, creates a unique timestamp/UUID backups/... key, stores that entire value, then upserts the current key. There is no snapshot count/byte/age cap in this path.
- [repositories.ts:315](../../src/lib/repositories.ts#L315): ticket update rewrites the full ticket array, may append history by rewriting its full array, appends audit, and refreshes customer balances by rewriting the customer array. A routine edit can therefore produce snapshots of several datasets.
- [repositories.ts:192](../../src/lib/repositories.ts#L192): the active audit list is capped at 10,000 entries, but historical copies of it are not capped. The cap does not prevent snapshot growth.
- [json-store.ts:128](../../src/lib/json-store.ts#L128) and [backup-restore-policy.ts](../../src/lib/backup-restore-policy.ts): Settings lists/restores these snapshots; they are not unreferenced disposable cache.
- [repositories.ts:448](../../src/lib/repositories.ts#L448): import rollback depends on recorded backup paths. **67 referenced paths exist**, consuming **2.900 MiB**. Moving them without a replacement retrieval path would break rollback.

Snapshot timestamps span **2026-06-24 to 2026-09-16**, 85 calendar days / 60 days with snapshot activity. Stored snapshot accumulation averaged **16.250 MiB per calendar day**, or **23.020 MiB per active day**. The largest measured day, 2026-09-16, accumulated **176.739 MiB** in 185 snapshots. These describe the recovered history, not current production growth or a guaranteed forecast.

### Current business data is small

| Current JSON dataset | Records/type | Stored MiB | Logical text MiB |
| --- | --- | ---: | ---: |
| core/ticket-history.json | 5955 | 1.822 | 3.322 |
| core/tickets.json | 1328 | 1.638 | 2.642 |
| audit/audit-log.json | 3341 | 0.284 | 1.032 |
| reports/generated/[redacted].pptx | object | 0.067 | 0.252 |
| core/customers.json | 30 | 0.006 | 0.018 |
| imports/import-batches.json | 5 | 0.004 | 0.008 |
| auth/users.json | 14 | 0.002 | 0.003 |
| master/sla.json | 12 | 0.002 | 0.001 |
| master/categories.json | 12 | 0.002 | 0.002 |
| reports/report-jobs.json | 5 | 0.002 | 0.001 |
| master/teams.json | 19 | 0.001 | 0.002 |
| master/statuses.json | 12 | 0.001 | 0.001 |
| master/holidays.json | 19 | 0.001 | 0.002 |
| imports/mappings.json | object | 0.000 | 0.000 |
| master/priorities.json | 4 | 0.000 | 0.000 |
| master/contract-types.json | 3 | 0.000 | 0.000 |
| master/issue-types.json | 3 | 0.000 | 0.000 |

Current ticket comments/logs are embedded: 802 entries across all 1,328 tickets. There are 5 inline PNG attachments, 854,925 decoded binary bytes and 1,140,014 data-URL characters, all valid base64. They remain outside the 90-day candidate set in this measurement. There are 124 embedded SLA pause records.

History stores previousValue/nextValue. In particular, 687 ticketLogs history changes contain 1,910,730 logical bytes, about 55% of active history text; changing a log can copy nested comments/attachments into history before the entire history array is snapshotted again. It is an amplification layer, but active history itself is only 1.822 MiB stored.

There are 5 import batches and small mapping metadata; no large imported workbook blob is present in app_store. Monthly Report Factory files are a separate filesystem dependency, described below. There is one generated report asset, only 0.067 MiB stored. Supabase storage.objects/buckets are empty; object storage metadata is not the source of the 1.42 GiB.

### TOAST, indexes and bloat

Most JSON snapshots are compressed with pglz and stored out of line in TOAST: 6,018 snapshot values and 9 active values report that compression. Compression is already active; an external gzip archive is not saving uncompressed SQL bytes one for one inside PostgreSQL.

public.app_store's TOAST relation contains approximately 1,439.641 MiB including its indexes, dwarfing the main heap. Statistics show 6,102 live app_store rows and zero estimated dead rows, and 729,965 live application TOAST chunks with zero estimated dead chunks. There are no application-table updates/deletes since this restore. Small dead-tuple estimates exist in system-catalog TOAST relations, not in the dominating application TOAST relation.

**Bloat is not a measured explanation for this restored footprint.** These statistics are estimates; exact dead/free-space inspection via pgstattuple is unavailable because it is not installed, and no extension or schema change was allowed. Production bloat remains unknown: dump/restore carries live data rather than pre-existing physical dead space. No VACUUM/ANALYZE/repacking was run by Phase 01.

Local WAL allocation is **1,056,964,608 bytes (~1,008 MiB)** from recovery activity, measured separately. WAL and Docker VM allocation are not part of pg_database_size(supper_restore), and are not extra business data or ticket-archive savings.

## 4. Ticket dependencies and retention boundaries

There are no support_tickets, support_ticket_history or support_customers tables in this database. SQL foreign keys cannot protect relationships inside JSON arrays. All **29 actual foreign keys** concern auth/storage service objects; none links SUPPER ticket/history/customer JSON. They were validated during Phase 00. No schema constraints were added here.

| Object | Actual storage / join | Archival dependency |
| --- | --- | --- |
| Ticket | app_store core/tickets.json; stable ticket id, issueId, customerKey | Preserve original id; issueId is not globally unique in this dataset. Include dates/status/subject/effort and nested content. |
| History | core/ticket-history.json; ticketId and issueId | Use ticketId first; use issueId fallback only if unambiguous. Current detail loader accepts either match, so duplicate issueIds need reconciliation. |
| Comments and attachments | ticket.ticketLogs[].attachments[]; inline dataUrl | Preserve actors, order, timestamps and binary bytes/content type. Detaching files requires an explicit retrieval adapter. |
| SLA | master/sla.json, holidays, ticket severity/start/due/close and slaPauses | Keep shared rules/holidays hot; retain ticket-specific pauses and historical rule/version context for reproducible SLA results. |
| Customers/contracts | core/customers.json; customerKey | Keep all 30 hot, including historical project identity and contract/manday carry-forward. Archived-ticket effort must remain in lifetime summaries. |
| Audit | audit/audit-log.json; entity, entityId, details | Preserve ticket audit and deleted-ticket tombstones; keep unmatched/non-ticket audit available. Never infer that orphan-like audit is disposable. |
| Import rollback | imports/import-batches.json.backupPaths[] | Preserve the 67 referenced snapshots or provide verified archive-aware rollback access before moving them. |
| Simple reports | reports/report-jobs.json; customerKey/month/outputPath; report asset in reports/generated/... | Keep job/manifests and report bytes retrievable; generation must merge hot and cold tickets without double counting. |
| Monthly Report Factory | data/reports/monthly filesystem: source workbooks, normalized datasets, batch metadata, exports | Not recovered by the database dump. Must be inventoried separately before claiming complete monthly-report reproducibility. |

Dependencies above are grounded in [types.ts](../../src/lib/types.ts), [repositories.ts](../../src/lib/repositories.ts), [domain.ts](../../src/lib/domain.ts), [report-storage.ts](../../src/lib/report-storage.ts), [report-generator.ts](../../src/lib/report-generator.ts), [monthly-report-factory.ts](../../src/lib/monthly-report-factory.ts), and the actual catalog inventory.

## 5. Closed-ticket archive candidates

### Exact age definition and independent check

Use a fixed calendar boundary: as of **2026-10-15 00:00 Asia/Bangkok**, strictly older than 90 days means **closeDate < 2026-07-17 00:00 +07:00**, AND kanbanStatus = closed. ISO datetimes retain their timezone; timezone-free dates/datetimes are interpreted as Asia/Bangkok. Missing/invalid closeDate is excluded, not replaced by createdAt/date/updatedAt. Dates on the cutoff day are retained unless their actual instant is strictly earlier. This is a reproducible calendar-day policy, not an arbitrary moving current-hour cutoff.

Python parsed the actual JSON and an independent read-only SQL check with timezone Asia/Bangkok confirmed **828** age-eligible tickets. None has closeDate exactly equal to the boundary. Among 1,109 closed tickets: **7 have blank closeDate**, **1 has an invalid nonblank closeDate**, **23 have a future closeDate** as of the analysis date; the other **250** have valid closing instants on/after the cutoff and not in the future. Using the ticket creation/business date instead would count **939**, which is a different question and was not used for eligibility.

| Candidate set | Tickets | History records | Ticket audit | Embedded logs | Attachments | SLA pauses | Compact logical MiB | In-memory gzip-9 MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Age eligible, not approved for removal | 828 | 2136 | 1724 | 170 | 0 | 2 | 1.853 | 0.296 |
| Conservative analysis subset, still requires approval/design | 678 | 1898 | 1416 | 156 | 0 | 2 | 1.591 | 0.254 |

Logical bundles above include ticket records (with their embedded logs/pauses), matching history and ticket audit exactly once. They do not include shared customer/master records, external report files, retained snapshot copies, archive manifests/encryption/index overhead or a complete legal audit retention package. They are measured would-be payload/compression sizes in memory, not actual exported archives. Different bundle splitting/compression settings will change final sizes.

### Conservative subset and records to keep hot

A deliberately stricter analysis filter excludes age-eligible tickets with missing owners, duplicate/missing issueId, a pre-2000 business date, invalid ticket date, close-before-start chronology, history ID/issue conflicts, or an invalid/recent updatedAt (on/after the cutoff). These additional holds are recommendations for review, not existing application rules or a claim that every such record is unarchivable forever.

**678** pass those filters; **150** of the 828 are held. Overlapping reasons: missing owner **12**, close-before-start **128**, pre-2000 date **1**, invalid ticket date **1**, recent/invalid update **8**. No candidate hit a duplicate issueId/history conflict hold. Categories overlap and must not be summed as distinct records.

Under that conservative scenario, **650 current tickets remain hot**: all 219 non-closed tickets, 281 closed tickets not age eligible, and 150 held age-eligible tickets. Also keep current customers/contracts, users/permissions, SLA/master/holiday rules, import metadata/rollback references, archive index/manifests and reporting aggregates available. The six deleted-ticket history records must be preserved until a tombstone/archive mapping exists. In the recommended first storage step, keep **all 1,328 current tickets hot**; external snapshots already address almost all excess storage.

## 6. Data integrity findings

### 33 tickets without owners

- Statuses: 12 closed, 16 in_progress, 3 waiting, 1 resolved, 1 cancelled.
- None has a nonblank alternate owner in ownerEfforts; 11 have positive mdUsed.
- 12 are in the 828 age-eligible set and are held from the conservative subset. Do not invent an owner from an actor/importer/team name. Ownership is free-form application data, not a SQL-enforced user reference.

### Six orphan-like history rows: evidence of an earlier deleted ticket

All six refer to **one ticket ID / one issue ID**, come from ui, and span 2026-06-28 to 2026-07-07. Fields changed: closeDate, dueDate, startDate, category, mdUsed, ownerEfforts. There is no current ticket match by either ID.

Read-only JSON path inspection found the ticket/reference in **394 old ticket snapshots**, first 2026-06-28, last 2026-07-14. The current audit contains one matching create, two updates and one delete, with deletion at **2026-07-14T05:31:25.942Z**. Source [repositories.ts:342](../../src/lib/repositories.ts#L342) removes the ticket from its active array but leaves its history array intact. Taken together, this is strong evidence of retained history after a pre-recovery application deletion, rather than restoration data loss. The deleted record was not reinserted and history was not edited. Preserve the snapshots/audit externally with a deleted-ticket tombstone and stable ID mapping.

### Suspicious 1978 date

One closed ticket has date **1978-02-12**, startDate **2026-02-18**, closeDate **2026-02-24**, and record creation/update in June 2026. It enters the raw age set through its genuine recorded closeDate, but is held by the conservative policy because its business date is inconsistent. The two retained history changes are customerKey and issueType from excel; they do not explain how the date became 1978. Excel import has serial and D/M/Y conversions ([excel-import.ts:141](../../src/lib/excel-import.ts#L141)), but blaming a specific conversion would be speculation without the original workbook. Do not silently replace the year. The anomalous date can distort customer elapsed-month burn-rate calculations, because domain.recalculateCustomer examines ticket.date.

### Additional findings affecting safe archival

- 128 age-eligible tickets close before startDate; none of the 128 chronology conflicts is merely an earlier time on the same calendar day. Review import/source-date semantics before moving them.
- 23 closed records have future closeDate; valid closing dates extend to 2026-12-05. These are not age-eligible and remain hot.
- One duplicate issueId group contains two current tickets. Stable ticket ID must be the archive/index identity; do not use issueId as a unique key.
- No active ticket has a missing current customerKey reference. No history ticketId/issueId conflict or unique-issue fallback case was found in current data.
- **4 of 5 report jobs have no matching generated-asset payload** in this recovered database; only one generated report asset exists. **2 of 5 report jobs have no matching current customer key** (none use a current customer ID instead). These are existing inconsistencies, not produced by Phase 01. Do not claim complete report recovery or historical regeneration until reconciled.
- The 5 existing report jobs have zero exact customerKey + ticket.date-month intersections with the current 828 candidates. That limited observation does not prove general report compatibility: users can request other historical months/projects and customer usage calculations span time.
- Original source/restored active datasets matched hashes in Phase 00; these are baseline data issues. No records were corrected to improve counts.

## 7. Compatibility with application behavior

| Capability | Actual implementation | Required before removing historical tickets from hot JSON |
| --- | --- | --- |
| Historical search/detail | ticketRepository.list/get and loadTicketDetailData load current JSON; ticket-manager filters issueId, title, customer and owner in memory. | Archive-aware search over a small index, consistent filters/pagination, detail retrieval by stable ID, and access checks equivalent to live tickets. An external ZIP alone is not searchable or compatible. |
| Recurring issue detection | Monthly Report Factory normalizeSubject lowercases/strips dates/numbers/punctuation, keeps up to 18 significant tokens. buildIssueListRows counts exact normalized subjects per company/project, threshold >3, within selected normalized monthly datasets. | Preserve raw subject plus a versioned identical recurrence key and project/customer identity. Feed historical source rows into the same scoped calculation. Current code does not provide global fuzzy/semantic historical detection; do not promise it or introduce embeddings as a prerequisite. |
| Customer/project lifetime reporting | domain.recalculateCustomer sums chargeable tickets by customerKey; refreshCustomer passes current tickets. | Keep cumulative historical manday totals or query a deduplicated hot+cold view. Raw candidates carry **629.298281 chargeable MD** across 21 customers; losing them from the inputs would undercount usage. Conservative subset carries 591.235781 MD across 20 customers. |
| Simple monthly presentation | API reports uses loadDashboardData; report-generator filters ticket.date month and sums effort; customer lifetime totals appear in the output. | Merge archived and live tickets by date and project while preserving original dates, owners/efforts and current/historical contract context. Preserve existing binary report artifacts, manifests and job links. |
| Monthly Report Factory | Reads data/reports/monthly source/normalized files, separate from app_store. | Inventory and retain those files and parser versions. A ticket JSON archive does not replace the workbook pipeline or its export history. |
| Ticket history/audit and rollback | History lives separately; Settings restore and import rollback read snapshots by key. | Link ticket/history/audit/tombstone payloads in immutable manifests; archive-aware retrieval and deliberate rollback semantics. A rollback must not resurrect cold tickets into active storage or create duplicates silently. |

Source references: [ticket-manager.tsx:300](../../src/components/ticket-manager.tsx#L300), [repositories.ts:109](../../src/lib/repositories.ts#L109), [domain.ts:284](../../src/lib/domain.ts#L284), [monthly-report-factory.ts:201](../../src/lib/monthly-report-factory.ts#L201), [monthly-report-factory.ts:322](../../src/lib/monthly-report-factory.ts#L322), [monthly-report-factory.ts:401](../../src/lib/monthly-report-factory.ts#L401), [report-generator.ts:20](../../src/lib/report-generator.ts#L20), and [api/reports/route.ts](../../src/app/api/reports/route.ts).

## 8. Estimated savings and confidence

| Scenario | Measured input / estimated effect | Confidence and limitation |
| --- | --- | --- |
| Phase 01 as executed | **0 bytes reclaimed**; all data retained. | Certain: read-only operation. |
| Archive only 828 age-eligible tickets plus matching history/audit | 1,943,411 compact logical bytes; 310,193 gzip bytes. Proportional current stored payload reduction **1,034,369 bytes (~0.99 MiB)**; practical estimate **0.5–1.5 MiB** before replacement-index cost. | High for logical/compression measurement; low-to-medium for actual PostgreSQL physical savings. Removing array elements changes compression and may create fresh snapshots. The historical copies still retain the tickets. |
| Conservative 678-ticket subset | 1,668,170 logical bytes; 266,040 gzip bytes; proportional stored reduction **890,074 bytes (~0.85 MiB)**. | Same limitations. A searchable index may offset much/all of this small saving. |
| Exact snapshot duplicate screen only | 39 excess rows, **11.38 MiB** stored payload. | High for measurement, not deletion eligibility; insufficient for Free. |
| All snapshots external, all live business data retained | **1,381.215 MiB** stored JSON offloaded. Physical opportunity approximately **1.35–1.42 GiB** after appropriate future compaction/rebuild. Toy local projection approximately **15.73 MiB** remaining. | High confidence in dominant cause; medium for physical reclaim. Local projection is not hosted service size and is not measured after removal. |
| Example bounded policy: retain latest 2 snapshots per target plus all 67 import references | Retain **90 rows / 10.423 MiB** snapshot payload; externalize **5,995 rows / 1,370.792 MiB**. Toy local projection approximately **26.56 MiB** remaining. | Counts/bytes measured for this exact hypothetical selection; medium/low for future footprint. Policy is illustrative, not approved or guaranteed to preserve every business recovery need. |
| Hosted operational DB + small archive index + bounded snapshots | Planning range **80–120 MiB**, leaving roughly **357–397 MiB** below a conservative 500,000,000-byte quota. | Estimate only; actual hosted extensions, other databases, indexes, catalog data, churn and retained snapshot budget must be measured. |

Physical projections above use observed total TOAST/stored-JSON ratio **1.0394**, leaving existing non-TOAST allocation in place. This is an accounting proxy, not a physical storage experiment. PostgreSQL compression is per value; mixed pages and chunk/index overhead mean per-key physical bytes are not directly attributable from pg_column_size. No table rewrite or empty comparison database was created to test the projection.

A small all-ticket search metadata projection (16 selected fields for 1,328 tickets, excluding bodies/attachments/passwords) measured **832,856 compact JSON bytes / 114,078 gzip bytes** in memory. This is not PostgreSQL index size. Budget roughly **1–5 MiB** for actual row/index overhead initially, then measure in a later phase. Raw subjects/owners can still be confidential and require application authorization.

The snapshot payload is about 4.36 GiB of logical text. The existing full-cluster original gzip is 863,452,506 bytes (~823.45 MiB), an existing reference point rather than a measurement of new archive packaging. A tentative compressed snapshot budget is **0.8–1.2 GiB** before replication/version retention/encryption overhead, with low-to-medium confidence; partitioning and compression ratios can change. Verify actual stream sizes and checksums in a later authorized archival phase.

Deleting rows or replacing JSON does not guarantee an immediate reduction in allocated database size. PostgreSQL generally reuses freed pages; returning allocation to the filesystem can require a separate maintenance/rebuild decision, with lock/temporary-space risks. No such operation is authorized or executed here. See [PostgreSQL routine vacuuming](https://www.postgresql.org/docs/17/routine-vacuuming.html) and [storage-size functions](https://www.postgresql.org/docs/17/functions-admin.html).

## 9. Recommended storage design

### First, fix the snapshot mechanism while keeping current tickets operational

The smaller sufficient first storage change is to retain all current tickets/history/customer data in Supabase and move historical full-dataset snapshots into an external, immutable compressed snapshot store with a bounded hot recovery window. That addresses almost the entire footprint and avoids changing ticket/report semantics prematurely. Both Settings restore and import rollback need tested archive retrieval before any snapshot is removed from PostgreSQL. A byte budget is necessary: time-only retention could still grow beyond Free in a busy week.

### Later historical ticket archives

- **Supabase PostgreSQL hot data:** operational tickets, current customers/contracts, users/permissions, shared master/SLA rules, active history, cumulative historical reporting totals, archive manifests and searchable metadata. Use the existing storage boundary; assess whether future relational mode is justified separately. The schema scripts already exist but this phase did not apply them or assume migration is safe.
- **External compressed object payloads:** immutable, bounded bundles by customer/project and closing month, with original ticket/history/audit data and attachment objects. Snapshot archives and business-ticket archives are different products: snapshots support rollback; ticket bundles support search/reporting. Preserve both purposes with versioned manifests, hashes, record counts, schema versions, close-date rule/timezone and export lineage. Locally use /Volumes/Vault/storage/supper/archives only when a future phase authorizes actual export; no such payload directory was populated here.
- **Searchable archive index:** stable ticket UUID, issue ID as a nonunique field, customer/project key, original subject + versioned normalized subject, lifecycle/report dates, status, severity, effort/chargeable summaries, permitted owner filter data and archive locator/checksum. Deduplicate on stable ID and archive revision. The current duplicate issueId prevents a unique issueId index without review. Exact normalized-subject indexing supports the existing recurrence semantics; add more expensive fuzzy search only if required and benchmarked later.
- **Read-only retrieval:** authorize using current application RBAC and customer/project scope before looking up objects; retrieve only server-side with scoped credentials, verify checksum/schema and bounded decompression size, return read-only ticket/history views. Handle unavailable/corrupt objects explicitly. Do not expose raw bucket paths or auto-write archived records back into live JSON during reads.
- **Reliability and recovery:** durable off-machine storage plus a second recovery copy, encryption and restrictive access for customer content and auth snapshots, restore drills, manifests independently recoverable if the hot database is lost, retry/idempotent publication and reconciliation. Publish/verify object and index before a separately approved removal step. A Vault-only external archive is not remote disaster recovery.
- **Growth control:** bound hot snapshot count AND bytes, keep required rollback/tombstone references, monitor database/catalog/index/TOAST growth and enforce capacity policy before the 500 MB hard boundary. Active snapshots must not reproduce an archive inside PostgreSQL after every edit.

No new infrastructure, schema, queue, cron, code path or archive implementation was added by this analysis.

## 10. Supabase Free feasibility and headroom

As checked on 2026-10-15, Supabase documents a **500 MB database quota** for Free; WAL is separate disk usage. Hosted instances also have baseline service/extension overhead, and the cluster total includes other databases. Account restrictions can persist independently of a single live-size reading. [Supabase database-size documentation](https://supabase.com/docs/guides/platform/database-size), [billing quota](https://supabase.com/docs/guides/platform/billing-on-supabase).

**Current code/data: not sustainable on Free.** Current 1.42 GiB already exceeds the quota by about three times. Moving old tickets alone does not fix it; repeated full snapshots would continue to grow.

**With external snapshots and enforced bounded retention: realistically plausible at this workload size**, subject to measured hosted footprint, operational performance and archive availability. The 80–120 MiB hosted range is a planning allowance, not a guarantee. Use a 300 MB planning ceiling to preserve growth/maintenance headroom; include the archive index and retained snapshots in that budget, and monitor actual cluster billing metrics.

At the recovered historical snapshot accumulation rate, starting from a hypothetical 100 MB baseline leaves 400 MB until the quota: approximately **23.5 calendar days**, or **16.6 active writing days**, if behavior persisted. At the observed peak day it is about 2.2 such days. These are extrapolations from snapshot history, not live-production forecasts; they explain why a one-time purge/archive without fixing the writer would fail again.

Capacity fit does not establish production performance, report correctness, service availability or cost of external storage/egress. This local analysis did not contact Supabase production or change its plan/configuration.

## 11. Phase 02 / Phase 03 recommendation and blockers

**Phase 02 — design and validation, only after a new explicit instruction:**

1. Specify external snapshot storage, durability/encryption, bounded hot retention, byte budget, import/Settings restore behavior and failure handling. Prioritize snapshot amplification; keep all 1,328 live tickets initially.
2. Agree lifecycle rule: closeDate/timezone/cutoff and whether last modification/ownership/chronology holds are mandatory. Review the 150 held age candidates, duplicate issue IDs, 1978/invalid/future dates and historical customer/report references without silent corrections.
3. Specify archived search/detail and reporting semantics, including historical manday totals, normalized-subject recurrence scope and tombstones for the deleted ticket. Inventory Monthly Report Factory filesystem assets and resolve the four missing generated payloads.
4. Validate on isolated copies with object round-trips, counts/hashes, rollback tests, missing/corrupt object cases and before/after customer/monthly/recurrence comparisons. No production deletion until separately reviewed and authorized.

**Phase 03 — controlled implementation/export, only after a separate go-ahead:** implement the approved writer/retention/retrieval boundary, export and verify immutable data, provide the searchable index/report-aware hot+cold view, and measure real hosted/storage changes. Any data removal, compaction or production cutover is a separate consequential operation; this report is not authorization for it.

Blockers: archive-aware Settings/import rollback absent; original source-date semantics unresolved; report assets/customer links inconsistent; Monthly Report Factory filesystem not verified; archive index/search/report adapters not built; no actual hosted compact-footprint measurement; business/legal retention rules not supplied. These block a safe automatic archival cutover, not read-only analysis of the recovered database.

## Evidence and completion checks

Aggregate evidence and reproducible SELECTs are retained outside Git under /Volumes/Vault/storage/supper/forensics-20261015. No messages, names, credentials or decoded attachment bytes were persisted in those forensic aggregates. Original backup files were never opened for writing. No production URL/API was invoked, and source code/application behavior is unchanged.

Checks completed: 42 exact counts; per-table physical reconciliation; 6,102 app_store baseline guard; actual 1,328/1,109/30 business counts; independent Python/SQL count of 828 candidates; archive compression measured in memory; JSON snapshot grouping/duplicate screen; existing import references and report payloads checked; deleted-ticket evidence inspected; no cleanup or archival executed. Phase 01 stops here.
