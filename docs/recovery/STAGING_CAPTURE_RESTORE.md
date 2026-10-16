# Minimal staging capture and controlled restore

2026-10-16: **STAGING_CAPTURE_RESTORE_READY** for the tested SUPPER ticket dataset. This is positive capture/restore evidence, not whole-application or production readiness.

## Source and scope

The Owner supplied credentials in ignored/untracked `.env.supper-staging.local`. The Project URL reference matched the previously Owner-approved `supper-staging` endpoint reference and staging bucket identity; identity was not inferred merely from a hostname. No credential values or payloads are in this report/logs/fixtures. Only authenticated HTTP GET requests were sent to Supabase.

Read-only preflight found `app_store` empty and the relational SUPPER tables present: customers 1, tickets 2, history 3, audit 10, users 1; master data, import batches/snapshots and report jobs/assets were empty. The narrow capture selected **all 2 `public.support_tickets.data` records**, ordered by relational ID, with an exact-count completeness check. These are the actual business JSON documents read by `relational-store.ts`, not newly seeded test fixtures. Relational ID/issue ID were checked against document identity and the application's ticket list schema accepted the source.

A single GET provided the complete selected dataset. A second GET after restore yielded the same full relational-row digest, confirming observed stability during this validation. This is a single-table read, not a transactionally consistent multi-table backup.

## Produced Vault artifact

Backup identifier:

`backups/core/tickets-1792119458950-225cef68-d04f-4faa-bbc5-8811f03b1e22.json`

Snapshot directory:

`/Volumes/Vault/storage/supper/snapshot-archives/local-vault/objects/2026/10/core/tickets/3e050d3c635ee6de19ba208995e1e9b73559cfd8cacae44b024025a7fd0d6ca7/`

It contains `snapshot.json.gz` and `manifest.json`, written through `VaultAuthority.save` and the existing immutable filesystem store. Category **manual**, no deletion/prune invocation. Protected recovery catalog:

`/Volumes/Vault/storage/supper/snapshot-archives/local-vault/catalogs/staging-capture-225cef68-d04f-4faa-bbc5-8811f03b1e22.json`

Verified exact-byte export:

`/Volumes/Vault/storage/supper/recovery-exports/staging-capture-225cef68-d04f-4faa-bbc5-8811f03b1e22.json`

- Raw bytes: **2,945**; gzip bytes: **1,074**.
- Raw/canonical business-data SHA-256: `e08598945b0c0f196886c324aa53aed89bed964a452a35d391459f86e2311eb1`.
- Compressed SHA-256: `d6b8decbef520d2752918448beb64be330e1a718033601d3f01d893794333f8f`.
- Vault read-back validated metadata identity, compressed hash, gzip integrity, raw hash/length and JSON. Export file hash matched the raw snapshot hash.

No protected historical snapshot or original archive was mutated. The existing 6,085-entry manifest pin remained enforced by Vault readiness. This run did not repeat the previous full historical archive scan.

## Controlled restore and usable-data evidence

Created only a new database in the existing **local** `supper-recovery-pg17` container:

`supper_staging_restore_225cef68d04f4faabbc58811f03b1e22`

It started with an empty `public.app_store` table using the application's key/value shape. Restore inserted **only the verified Vault export** into `core/tickets.json`; neither the original in-memory source nor the second HTTP read supplied restore bytes. No existing local recovery DB was selected for writes.

Checks passed:

- Restored ticket count **2/2**, complete original business JSON preserved.
- Canonical restored SHA-256 equals the captured raw hash above.
- Actual SUPPER `ticketListSchema` accepts restored documents.
- PostgreSQL JSONB lookup by a captured ticket ID returns exactly one record.
- Existing `ticketEffortHours`, `ticketOwnerList` and `ticketSeverityLabel` domain functions operate on both restored tickets, with finite effort values and valid return types.
- Staging source full-row digest before/after: `f6ec6f7e0ff2e69945a7079849dddf0609f044c7245b56e912028411bc5a0e7f`.

This demonstrates a usable ticket dataset in safe isolated state. It does **not** validate a full relational-schema reinstatement, login/browser workflow or customer/report cross-table consistency. The isolated database and protected Vault snapshot/export remain available for inspection; no cleanup or prune was performed.

## Exclusions

Other SUPPER datasets were outside this minimal ticket proof: customer/history/audit/user data and empty master/import/report tables. Supabase Auth/service schemas, policies, indexes, grants and external object/attachment resources were not backed up or restored. Relational denormalized columns and timestamps were covered by the source-stability digest but not reconstructed into relational tables; the restored authoritative ticket business JSON remains exact. These exclusions avoid turning a minimal validation into system-wide DR certification.

## Tooling and checks

Added the explicit local command `node scripts/staging-capture-restore.mjs --staging-only`. It has fail-closed target/completeness/schema/hash/lookup/domain assertions, uses a new UUID for each isolated database, never exposes response/SQL assertion operands on failure, and has no scheduling, prune, remote object-storage or deployment code. A deliberate future invocation produces another protected capture; it is not an automatic retry or job.

Actual run: exit **0**, capture/restore assertions passed. Evidence: [STAGING_CAPTURE_RESTORE_EVIDENCE.json](STAGING_CAPTURE_RESTORE_EVIDENCE.json). The original run evidence also resides privately under `/Volumes/Vault/storage/supper/staging-capture-validation/225cef68-d04f-4faa-bbc5-8811f03b1e22.json`; repository evidence additionally records final checks/source hash.

- Regression: **207 passed, 16 skipped, 0 failed** (28 passed suites, 6 skipped).
- Full TypeScript check, new-script ESLint, `git diff --check`: exit **0**.
- Real staging capture/restore is a separate successful assertion-based operator run; skipped opt-in suites are not claimed as current passes.

## Proposed RPO and remaining deployment gates

Recommend a manual **daily capture (24-hour RPO)**, plus a capture **before each bulk import, restore or risky data operation**, for Owner approval. This suits the currently small staging ticket workload and avoids premature automation; production write volume may warrant a shorter interval. A missing/unmounted Vault or missed capture means the proposed RPO is not being met and must be reported explicitly. No schedule/automation was built.

Before staging application deployment: approve the RPO and named operator/manual run procedure; decide the operational capture coverage beyond this validated ticket subset; verify the staging application environment/DB/Auth configuration, isolated build and application smoke test. Existing dependency-security and report-worker/asset gates apply only to the relevant deployment functionality, as previously recorded. This validation does not enable snapshot-before-every-web-write.

**Remote object storage and independent backup are not blockers for this deployment path.** Real-data prune remains operationally blocked pending complete reference inventory validation; this manual snapshot is additionally pinned by category/catalog. Do not invoke real prune based on the capture test.

No staging write, production access/mutation, historical prune, commit, push or deployment occurred. Working tree retains pre-existing mixed recovery/application edits plus this script/report/evidence. HEAD: `5b6f68ac28b9604f9d44b982397e77072aa2ba4a`.
