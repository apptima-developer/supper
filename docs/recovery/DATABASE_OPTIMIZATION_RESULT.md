# SUPPER Phase 03 — Database Optimization Result

Executed locally on 2026-10-15 (Asia/Bangkok). **PHASE_03_LOCAL_OPTIMIZATION_PASS**. Phase 04 is **NOT READY**; no production activation occurred. This phase migrates historical **snapshots**, not closed tickets. All current business records stay in PostgreSQL.

## Scope and reproducible procedure

Read AGENTS.md and all three preceding recovery reports. PostgreSQL server and tools are 17.6 in `supper-recovery-pg17`. The protected source is `supper_restore`; the only cleanup target is `supper_phase03_20261015`. Vault had approximately 1.8 TiB free and host temporary storage approximately 48 GiB free before starting.

New scripts contain fixed local container/database names. They do not read application credentials or connect to Supabase. Run from the repository root. Do not rerun clone creation against an existing database or overwrite a completed dump. The full migration can be resumed before cleanup; the compaction script deliberately refuses a second cleanup because its baseline no longer matches.

```sh
python3 scripts/phase03-clone.py
SUPPER_PHASE03_INTEGRATION=1 \
SUPPER_PHASE03_DATABASE=supper_phase03_20261015 \
SUPPER_PHASE03_ARCHIVE_ROOT=/Volumes/Vault/storage/supper/snapshot-archives/phase03 \
npx vitest run src/lib/snapshots/phase03-export.integration.test.ts -t "preserves recovery"
python3 scripts/phase03-compact.py
python3 scripts/phase03-integrity.py
```

The clone script creates a custom-format `pg_dump`, computes its SHA-256, creates the disposable database and restores with `pg_restore --exit-on-error`. Every app_store key, SHA-256, exact text byte length and source updated_at must match; 42 tables must exist. A host Python 3.9 compatibility error occurred after the dump completed (`hashlib.file_digest` unavailable). It was corrected to bounded chunk hashing; restore resumed using the unchanged completed dump. The checked-in script contains the correction.

Snapshot export calls the Phase 02 `migrateSnapshot` and `LocalFilesystemSnapshotStore` implementations. It reads one source payload at a time, preserving exact PostgreSQL `value::text`, original backup ID, target, timestamp, source revision and known import dependencies. Gzip objects and strict manifests are immutable and atomically published. Each payload is read back and compared exactly to the source. Metadata-only catalogs fit in memory; payloads are bounded by the adapter's 64 MiB per-object limit. A progress checkpoint is written every 100 successful objects; individual durable manifests provide finer-grained resume evidence. Reruns compare immutable objects and fail on conflicts, rather than replacing them. No source deletion occurs in the exporter. A second full read-back pass precedes publishing the independently readable `full-manifest.json`.

The cleanup script independently reads gzip objects without the TypeScript adapter and compares raw and compressed SHA-256 plus lengths against the protected source catalog. It requires exactly the complete set of 6,085 source keys. Inside one transaction it deletes only `backups/%` keys matching both verified identifier and source-content SHA-256. Any count other than 6,085 deleted / 17 retained raises an exception and rolls back. All current hashes and versions are compared again before and after compaction. No application table is dropped or truncated.

`VACUUM (FULL, ANALYZE) public.app_store` takes ACCESS EXCLUSIVE on this relation in the disposable clone and rewrites its heap/TOAST/indexes. Concurrent application traffic was absent. Temporary rewrite space and WAL must be budgeted separately for a future environment; the measured local free space was ample. Logical deletion alone is not represented as physical disk reclamation.

## Post-cleanup compatibility verification

A second explicitly disposable database, `supper_phase03_restoretests2_20261015`, is created from the compacted clone. It begins with **zero** PostgreSQL historical snapshot rows. Tests call real json-store, repository and backup-service code through a guarded PostgreSQL app_store adapter, not the Supabase HTTP transport. The recovery database is permitted only through `BEGIN READ ONLY` queries. Test-generated snapshots append to the filesystem; migrated historical objects remain immutable. Original migration counts are defined by the frozen 6,085-entry full manifest, separately from later test-generated objects.

```sh
docker exec supper-recovery-pg17 createdb -U supper_recovery_admin \
  -T supper_phase03_20261015 supper_phase03_restoretests2_20261015
SUPPER_PHASE03_RESTORE_INTEGRATION=1 \
SUPPER_PHASE03_RESTORE_DATABASE=supper_phase03_restoretests2_20261015 \
SUPPER_PHASE03_RESTORE_ARCHIVE_ROOT=/Volumes/Vault/storage/supper/snapshot-archives/phase03 \
npx vitest run src/lib/snapshots/phase03-restore.integration.test.ts
npm test
npx tsc --noEmit --incremental false
npm run verify:architecture
npm run verify:migrations
npm run verify:runtime-assets
```

The harness verifies external Settings identifiers/listing, all 67 referenced objects, pre-restore snapshots, admin rejection/success and a real database audit write. It exercises ticket create/read/update/delete, customer MD recalculation and report input loading. It resets test payloads before each of three completed import batch rollbacks, invokes the repository rollback boundary, and compares every restored target to the earliest original snapshot selected by existing rollback semantics. Final test current payloads return to their baseline; the optimized primary clone is never modified by these application tests.

Missing identifiers must fail with no source fallback available. Corruption is introduced only into a separately copied synthetic object directory; original migrated archives are never corrupted. The test checks failure before a current-data change. Existing unit tests additionally cover filesystem failure, incomplete publication, immutable retry, CAS conflicts, parallel writers, size limits and all-target rollback preflight. Existing multi-dataset rollback is not globally transactional; preflight prevents known missing/corrupt-object failures but cannot eliminate a later database write failure.

## Integrity scope and existing anomalies

Identical hashes of **all 17 current JSON values** cover every field and nested object, including ticket details/logs/attachments, owner assignments, statuses, customer MD values, SLA fields, master data, import metadata, report metadata and historical customer references. Equality is stronger than comparing selected field totals. Import paths are preserved under their original identifiers. The read-only inventory compares all 42 table counts (except the deliberately reduced app_store), relation identities and RLS flags. Final source catalog comparison includes all 6,102 rows, values, lengths and timestamps.

No anomaly is repaired: 33 ownerless tickets; 6 history references to one already-deleted ticket; the 1978-02-12 ticket business date; 128 close-before-start records in the prior age-eligible subset; 23 future closing dates; one duplicate issue-ID group/two tickets; invalid/missing closing dates and pre-existing report/customer-reference gaps. Whole-dataset hash equality proves these are unchanged. Current 5 inline attachments, 802 ticket logs and 124 SLA pauses remain inside their unchanged ticket JSON.

## Production readiness: NOT READY

Local filesystem success is not production readiness. Required before any Phase 04 activation:

| Area | Remaining work / acceptance gate |
| --- | --- |
| Remote adapter | Implement S3-compatible SnapshotStore save/read/list/verify with immutable conditional publication, pagination, checksums, retry semantics and failure injection. The present S3 contract is only an interface. |
| Durability | Independent backup/replication of payloads **and** manifests, versioning/object-lock policy, periodic full integrity scans and tested disaster recovery. A single mounted Vault volume is one failure domain. |
| Encryption/access | TLS, server-side encryption/KMS, least-privilege server IAM, rotation, tenant authorization, private bucket, retention and audit access policy. Local gzip is compression, not encryption; Vault encryption has not been established. |
| Secrets | Runtime secret management and environment separation; never expose keys or object locations to browser clients or Git. No remote credentials were inspected in this phase. |
| Vercel | Durable filesystem and local mkdir locks cannot be used as shared cross-instance storage. Remote adapter, distributed concurrency/CAS semantics, runtime memory/time limits and failure behavior must pass deployed staging tests. Current external flag explicitly rejects Vercel and non-test execution. |
| Timing/cutover | Freeze legacy writers in a maintenance/read-only window; capture source snapshot inventory and revisions; export/verify; reconcile a final delta; prove all import refs; atomically activate compatible reader/writer. Prevent old app instances from recreating PostgreSQL snapshots. |
| Idempotency | Persist per-object state and immutable manifests; compare identifiers/revisions/checksums on retry. Handle completed-object / failed-database-write and failed-object / unchanged-database cases. No pruning before complete independent read-back acceptance. |
| Rollback | Retain verified pre-cutover database dump and old writer deployment. Restore snapshot rows from archive or restore database under maintenance, reconcile business writes after cutover, verify import refs and current-data hashes before reopening. Do not merely flip a flag to a legacy reader whose payloads are absent. |
| Monitoring/capacity | Alert on object export/read/hash errors, CAS failures, stale locks, unresolved manifest refs, audit-write failures, database and external byte growth, retention backlog and backup age; define owners and thresholds. |
| Consistency | Multi-dataset imports/rollback still need production failure/recovery design. Decide transaction/outbox or equivalent reconciliation; preflight alone cannot make multiple PostgreSQL writes plus object storage atomic. |
| Activation | Explicit Phase 04 authorization, staging HTTP/UI integration, remote security/durability evidence, full repository typecheck resolution and reviewed runbook/rollback rehearsal. Production flags remain disabled. |

Keep current active data in PostgreSQL, immutable snapshots in durable object storage and rebuildable metadata catalogs for lookup. Existing filesystem manifests prove independent retrieval by original identifier; historical ticket search/monthly reports still use current business JSON because **no business-ticket archival occurred**. A searchable closed-ticket archive is a separate, unimplemented project.

## Regression limitations

Full repository typecheck is reported honestly: the known Phase 02 errors in `domain.test.ts`, `sla.test.ts`, `observability.test.ts` (two BigInt diagnostics) and `proxy.test.ts` persist. Unrelated fixtures were not changed. No production environment, Vercel configuration or remote bucket was accessed. No browser UI, PostgREST/Supabase HTTP service or deployed staging request was tested; repository integration uses real local PostgreSQL with a transport shim. Production readiness requires those additional checks.

## Execution measurements and final acceptance

Measured results are recorded below. Evidence containing private identifiers and database dumps remains outside Git under `/Volumes/Vault/storage/supper/phase03-20261015` and `/Volumes/Vault/storage/supper/snapshot-archives/phase03`.

## Recovery without changing the protected original

The pre-cleanup Phase 03 custom dump is `/Volumes/Vault/storage/supper/phase03-20261015/supper_restore.dump`; its expected SHA-256 is stored alongside it in `backup-sha256.txt`. To recover the original 6,102-row state into **another new disposable database**, first compare the checksum, then use these local commands. Refuse to proceed if the chosen name already exists; never substitute `supper_restore` as the target.

```sh
shasum -a 256 /Volumes/Vault/storage/supper/phase03-20261015/supper_restore.dump
cat /Volumes/Vault/storage/supper/phase03-20261015/backup-sha256.txt
docker exec supper-recovery-pg17 createdb -U supper_recovery_admin supper_phase03_recoverycheck_20261015
docker exec -i supper-recovery-pg17 pg_restore -U supper_recovery_admin \
  -d supper_phase03_recoverycheck_20261015 --exit-on-error \
  < /Volumes/Vault/storage/supper/phase03-20261015/supper_restore.dump
docker exec supper-recovery-pg17 psql -X -qAt -U supper_recovery_admin \
  -d supper_phase03_recoverycheck_20261015 -c \
  "BEGIN READ ONLY; SELECT count(*),count(*) FILTER(WHERE key LIKE 'backups/%') FROM public.app_store; SELECT key,encode(extensions.digest(value::text,'sha256'),'hex') FROM public.app_store ORDER BY key; ROLLBACK;"
```

Require `6102|6085` and compare the complete ordered key/hash inventory to `source-catalog.json` before using the recovered database. This procedure is documented, not an additional executed restore. The actually executed clone restore already validated every row's hash and version.

For individual historical recovery, the original backup ID resolves through `full-manifest.json` to a private gzip object and its own manifest. Verify compressed hash/length, decompress, verify raw hash/length, then use `SnapshotStore.getSnapshot` plus the existing schema-validated admin restore boundary in an authorized isolated context. Do not bypass authorization, use an unverified payload, or infer a restore target from a caller-supplied filesystem path. The manifests preserve every original target and identifier; no PostgreSQL historical row is required for retrieval. Current source business data remains available in the verified dump and protected `supper_restore`.

## Measured storage results

All byte values below are measured, not estimates. MiB = 1,048,576 bytes. The protected source remained 1,521,888,403 bytes at the initial check; the freshly restored clone differs slightly through PostgreSQL catalog/allocation overhead.

| Measurement | Before cleanup (bytes / MiB) | After logical cleanup (bytes / MiB) | After physical compaction (bytes / MiB) |
| --- | ---: | ---: | ---: |
| Database total | 1,521,896,595 / 1451.393695 | 1,521,904,787 / 1451.401507 | 14,912,659 / 14.221820 |
| app_store total | 1,511,211,008 / 1441.203125 | 1,511,211,008 / 1441.203125 | 4,218,880 / 4.023438 |
| Main heap | 925,696 / 0.882812 | 925,696 / 0.882812 | 16,384 / 0.015625 |
| TOAST including TOAST indexes | 1,509,572,608 / 1439.640625 | 1,509,572,608 / 1439.640625 | 4,186,112 / 3.992188 |
| Ordinary app_store indexes | 679,936 / 0.648438 | 679,936 / 0.648438 | 16,384 / 0.015625 |
| Current stored JSON | 4,018,635 / 3.832469 | 4,018,635 / 3.832469 | 4,018,635 / 3.832469 |
| Historical stored JSON | 1,448,308,419 / 1381.214541 | 0 / 0.000000 | 0 / 0.000000 |

Snapshot rows: **6,085 → 0 → 0**. Current keys: **17 → 17 → 17**.

Database space reclaimed: **1,506,983,936 bytes / 1437.172 MiB**, a **99.020127%** reduction. TOAST reclaimed **1,505,386,496 bytes / 99.722696%**. Confidence is **high for this measured local clone**; hosted Supabase overhead and future growth are not measured. Logical deletion returned no app_store disk space and total database allocation rose 8 KiB; physical rewrite achieved the saving.

Final database **14.221820 MiB**, below both the preferred 100 MiB and acceptable 300 MB planning thresholds. The small operational dataset has substantial local headroom, but sustainable hosted operation depends on deploying the remote writer safely and monitoring growth. This is not a hosted Free Plan capacity certification. The existing production writer remains unchanged/default-disabled external integration and can continue generating unbounded database snapshots until a separately authorized cutover.

## Snapshot migration results

- Original source snapshot identifiers: **6,085**.
- Exported: **6,085**; TypeScript full read-back verified: **6,085**; independent Python exact-source SHA-256 verification: **6,085**.
- Failed verification: **0**; unresolved migration errors: **0**.
- Import references: **67/67**, with batch identifiers in object metadata.
- Compressed payload bytes: **821,151,416 / 783.111015 MiB**.
- Per-object manifest bytes: **4,786,567 / 4.564826 MiB**.
- Frozen complete catalog bytes: **4,792,653**.
- Original archive payload + per-object manifests + complete catalog: **830,730,636 bytes / 792.246471 MiB** (logical file sizes, excluding filesystem allocation/checkpoint and later test-generated snapshots).

The full manifest is independently readable JSON, and each object has its own manifest. `snapshot-record-counts.json` records recovered array counts for every migrated payload; equality to the original source SHA-256 proves exact source content/count preservation. The central catalog may be rebuilt from per-object manifests. Later append-only test snapshots are counted separately in `phase03-test-evidence.json`, not added to the migration denominator.

## Business integrity results

| Dataset | Baseline | Optimized | SHA-256/content result |
| --- | ---: | ---: | --- |
| Tickets | 1,328 | 1,328 | Identical |
| Ticket history | 5,955 | 5,955 | Identical |
| Customers | 30 | 30 | Identical |
| Audit records | 3,341 | 3,341 | Identical |
| Application users | 14 | 14 | Identical |
| Import batch metadata | 5 | 5 | Identical, including all 67 backup references |
| Current JSON keys | 17 | 17 | All hashes and original updated_at revisions unchanged |

All 42 tables, 102 function identities/bodies, relation/index identities and RLS flags, constraint definitions/validation states, ordinary triggers and event triggers were compared read-only to the source. Only app_store historical row removal is allowed to differ. All source app_store hashes, keys, lengths and updated_at revisions remained equal to the pre-migration inventory. Original downloaded backups are checked by SHA-256, file size and modification timestamp.

## Verification evidence

Private artifacts remain outside the repository:

- `/Volumes/Vault/storage/supper/phase03-20261015/source-catalog.json`: all 6,102 source key/hash/length/revision entries.
- `clone-verification.json`, `supper_restore.dump`, `backup-sha256.txt`: actual clone restore evidence.
- `measurements.json`: exact before/logical/physical measurements.
- `phase03-result.json`: final acceptance summary, manifest SHA-256 and test/integrity evidence.
- `snapshot-record-counts.json`: all 6,085 recovered snapshot array counts and hashes.
- `final-integrity.json`: full current hashes and schema/table/function/constraint/trigger comparisons.
- `original-backups-baseline.json`, `original-backups-final.json`: original-file preservation.
- `/Volumes/Vault/storage/supper/snapshot-archives/phase03/full-manifest.json`: original 6,085-object catalog.
- `/Volumes/Vault/storage/supper/snapshot-archives/phase03/progress.json`: completed export/verification totals.
- `/Volumes/Vault/storage/supper/snapshot-archives/phase03-test-evidence.json`: post-cleanup application compatibility evidence.

No customer payload, credential, snapshot or generated database backup was added to Git. The pre-existing package-lock.json changes were preserved. Code added in Phase 03 is limited to guarded local scripts and opt-in integration tests; no further application behavior change was necessary.

## Final compatibility and regression results

**PASS — local Phase 03 acceptance.** Full export, independent read-back, clone-only deletion/compaction and unchanged source/current-data integrity all passed.

| Check | Result |
| --- | --- |
| Settings external snapshot listing | All 6,085 original migrated identifiers present |
| External historical retrieval / SHA-256 | All 6,085 verified; 67 import references re-read after cleanup |
| Settings admin restore | Passed; non-admin rejected, successful restore writes real database audit |
| Completed import rollback | 3/3 passed through repository boundary; restored targets equal the original earliest selected payloads |
| Missing/corrupt objects | Fail closed, current data unchanged; corruption confined to a separate copied fixture |
| Ticket CRUD | Create/read/update/delete passed on the optimized test clone |
| Customer MD / report data | Calculation values and report inputs preserved after CRUD |
| New external writer | Passed; final test database has 17 current rows and zero PostgreSQL snapshots |
| Immutable migration retries | Three already-exported objects retried twice after cleanup against read-only source payloads; exact content and object count unchanged |
| Baseline current JSON | All 17 SHA-256 values and revisions unchanged in optimized primary clone |
| Original recovery / backups | All 6,102 source row hashes/revisions unchanged; 4 original files' SHA-256/size/mtime unchanged |

Regression suite: **195 passed, 0 failed**, with four opt-in integration tests skipped by default. Separately executed Phase 03 integration checks: full export **1 passed**, post-cleanup compatibility **1 passed**, and post-cleanup idempotent retry **1 passed**. Total distinct executed passing tests: **198**, zero remaining failures. The full export check was executed before deletion; the retry check was explicitly selected afterwards:

```sh
SUPPER_PHASE03_INTEGRATION=1 \
SUPPER_PHASE03_DATABASE=supper_phase03_20261015 \
SUPPER_PHASE03_ARCHIVE_ROOT=/Volumes/Vault/storage/supper/snapshot-archives/phase03 \
npx vitest run src/lib/snapshots/phase03-export.integration.test.ts -t "retries already migrated"
```

Changed-test ESLint passed with zero warnings/errors; Python scripts compiled and their runtime safety assertions passed. Architecture, migration inventory and runtime-asset verification passed. Full repository typecheck still fails with **5 pre-existing diagnostics in 4 files**, exactly the Phase 02 baseline: missing Ticket fixture fields in `domain.test.ts`, optional category in `sla.test.ts`, two ES2017 BigInt diagnostics in `observability.test.ts`, and nullable AbortSignal incompatibility in `proxy.test.ts`. **Zero new typecheck diagnostics.** No unrelated fixture was changed or suppressed.

The first post-cleanup test attempt compared complete recalculated Customer objects, including the deliberately time-varying `updatedAt`, and failed that new assertion. The assertion was corrected to compare actual MD calculation outputs; no business implementation changed. Tests then passed on a fresh optimized child clone, and passed again with exhaustive original-ID listing coverage. The first disposable test clone is retained for inspection; the accepted test context is `supper_phase03_restoretests2_20261015`. Test payloads in the accepted context were restored to baseline and PostgreSQL snapshot count remained zero.

The archive contains **6,175 objects after all local test runs: 6,085 migrated source snapshots plus 90 append-only test-generated snapshots**. The frozen migration manifest and migration byte totals continue to refer only to the original 6,085. None of the original archive objects was pruned, overwritten or corrupted. No business ticket archival was performed.

## Acceptance checklist

- [x] Independent custom backup/restore clone verified against source.
- [x] 6,085 exported, read-back verified and independently source-hash verified.
- [x] All 67 import backup paths preserved and resolvable after cleanup.
- [x] Only verified historical keys removed from the explicitly authorized disposable clone.
- [x] Physical compaction completed and actual database/TOAST/index sizes measured.
- [x] All business payload hashes unchanged, schema objects preserved and anomalies retained.
- [x] External Settings restore, authorization/audit, three import rollbacks and writer tested without PostgreSQL snapshot fallback.
- [x] No new regression failures or typecheck errors; existing failures disclosed.
- [x] Original recovery and original downloaded backups unchanged.
- [x] No production access, environment activation, deployment or external upload.
- [x] Production readiness blockers and reproducible recovery procedure documented.

Recommendation: retain the verified dump, protected recovery database and complete archive. Phase 04 should begin only after explicit authorization and the remote adapter, durability/encryption, staging transport/runtime, concurrency/cutover/rollback and monitoring gates above are met. **Stop here; Phase 04 was not started.**
