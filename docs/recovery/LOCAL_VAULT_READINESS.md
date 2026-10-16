# SUPPER — Local Vault Snapshot Authority

2026-10-16. The next minimal staging ticket capture/isolated restore has now passed; see [STAGING_CAPTURE_RESTORE.md](STAGING_CAPTURE_RESTORE.md). **LOCAL_VAULT_READY** for the standalone local storage/maintenance contract. This does **not** mean the deployed application has continuous snapshots, staging is ready, or production is online. No deployment or commit is authorized or performed.

## Current architecture

The Owner's Vault is the authoritative snapshot/recovery medium. A local operator process runs `scripts/vault-snapshots.mjs`, reusing `LocalFilesystemSnapshotStore` and its existing gzip/manifest format. Vercel runs the web app; Supabase remains application DB/Auth infrastructure. Neither Vercel nor the web runtime imports the local maintenance component, mounts Vault, or writes to it. The local command has no database connection or mutation capability.

Remote-provider adapters and prior reports remain historical/test evidence. Supabase S3's observed failure to honor immutable conditional publication is retained in `REMOTE_SNAPSHOT_READINESS.md` and `PHASE04B_PROVIDER_EVIDENCE.json`; it is **no longer the current deployment blocker**. No R2, Backblaze or other provider work was undertaken. No remote machinery is imported by the local CLI.

| Path | Purpose |
| --- | --- |
| `/Volumes/Vault/storage/supper` | Fixed canonical root; must already exist on mounted Vault |
| `snapshot-archives/phase03` beneath root | Existing historical recovery store, read-only through local authority |
| `snapshot-archives/phase03/full-manifest.json` | Frozen authoritative 6,085-entry catalog |
| `snapshot-archives/local-vault/objects` | New immutable gzip snapshots and per-object manifests |
| `snapshot-archives/local-vault/catalogs` | Explicit immutable recovery-set catalogs; every member protected from prune |
| `snapshot-archives/local-vault/locks` | Cross-process local maintenance lock |
| `snapshot-archives/local-vault/operations` | Durable prune intent/result records |
| `recovery-exports` beneath root | Explicit verified JSON recovery exports; private, no overwrite |
| `phase04b-vault-synthetic/<UUID>` beneath root | Isolated validation fixtures, never application recovery data |

No migration/reorganization of Phase 03 is required to read it directly. The local authority reads active snapshots first, then historical snapshots **only for SnapshotNotFoundError**, after mount/readiness checks. Corruption and Vault-unavailable errors never trigger fallback. New writes go only to `local-vault`; historical deletion/migration is not implemented or authorized.

## Historical archive inspection

Mounted integration verification read every frozen entry through the existing filesystem store, validating object identity, gzip integrity, raw SHA-256, compressed SHA-256, byte counts and full metadata equality against the frozen manifest. **6,085/6,085 passed**. Frozen catalog SHA-256 before and after:

`585247ac16c6e4bc50a42db88cf11c10657180dab76ae1c48458024568a0af69`

The directory has **6,175 objects**, including the previously recorded **90 non-authoritative Phase 03 synthetic fixtures**. They are not silently promoted into the historical 6,085 set or removed. Historical writes/prune are inaccessible through the authority. Per-object manifests are the reconstructable index for new snapshots; named recovery catalogs additionally pin their members.

## Local operations

Run from the repository with installed local development dependencies (Node.js, Vite, TypeScript and the existing library dependencies). No new dependency was installed. These commands are local tooling, not a Vercel entry point.

```sh
node scripts/vault-snapshots.mjs init
node scripts/vault-snapshots.mjs ready
node scripts/vault-snapshots.mjs save /absolute/private/snapshot-input.json
node scripts/vault-snapshots.mjs verify 'backups/core/tickets-<timestamp>-<suffix>.json'
node scripts/vault-snapshots.mjs export 'backups/core/tickets-<timestamp>-<suffix>.json' recovered-tickets.json
node scripts/vault-snapshots.mjs catalog /absolute/private/catalog-input.json
node scripts/vault-snapshots.mjs prune /absolute/private/prune-request.json
# Only after reviewing the exact dry-run output:
node scripts/vault-snapshots.mjs prune /absolute/private/prune-request.json <approved-plan-digest>
```

`init` creates only new private maintenance/export directories beneath the already existing canonical root and archive parent. Existing archives are not initialized, moved, rewritten or cleaned. Files are 0600/directories 0700. Export returns only path/checksum and writes exact verified source JSON bytes with exclusive creation; it does not apply a DB restore. Treat exports as sensitive recovery data and apply application schema validation and the existing restore policy before any future DB mutation.

Snapshot input uses the existing `SnapshotInput`: `backupPath`, JSON text `json`, `createdAt`, `sourceVersion`, `category`, `relatedImportBatchIds`. Identical retries are idempotent; altered content/metadata for the same identifier is rejected. Catalog input: `{ "name": "recovery-set-name", "backupPaths": ["backups/..."] }`. Catalog files cannot be overwritten; each entry is fully verified before publication. The generic deletion API remains disabled.

## Vault mounted/unmounted behavior

Every guarded store operation checks that `/Volumes/Vault` has a different device from `/Volumes`, validates canonical real paths (no symlink substitution), requires pre-existing archive roots and private archive directories, and rejects a Vercel process. No recursive creation of the mountpoint or canonical root is allowed. Subdirectories are created one level at a time under an existing checked root. Missing/unmounted/unsafe Vault yields **VAULT_UNAVAILABLE_OR_UNSAFE**, with no alternative disk or provider.

Actual mounted readiness and I/O passed. Unavailable-volume tests simulate mount failure and root disappearance; they exercise init, read, write and list and prove the root is not recreated. **The Owner's live volume was not physically unmounted.** Checks cannot promise immunity to hostile mount replacement or sudden power loss; filesystem errors fail closed and incomplete objects are rejected. Remount the correct volume, run readiness/verify, and review stale locks and operation records before resuming. Never remove a lock while its owning process is alive.

## Explicit prune contract

Canonical-root real-data prune execution is now hard-blocked pending Owner-approved complete reference inventory; see STAGING_DEPLOYMENT_READINESS.md. Synthetic isolated test execution remains available. Prune defaults to dry-run. It displays exact candidate metadata/paths, estimated compressed+manifest bytes and a SHA-256 plan digest. Execution requires the same request plus the approved digest; any changed snapshot/catalog/reference state that changes the plan requires a fresh review. No scheduler or automatic prune exists.

Example request (replace timestamps/version and supply the **complete** actual reference inventory):

```json
{
  "before": "2026-01-01T00:00:00.000Z",
  "keepLatest": 2,
  "referenceInventory": {
    "version": 1,
    "complete": true,
    "capturedAt": "2026-10-16T00:00:00.000Z",
    "sourceVersion": "verified-frozen-source-revision",
    "referencedPaths": ["backups/..."]
  }
}
```

The inventory must be within 15 minutes of execution. A production/staging inventory must be captured from a **quiesced** application state and include all Settings/import rollback/history/audit/report recovery references. The local tool validates syntax, freshness and referenced object integrity; it **cannot independently prove operator-supplied completeness or freshness against a live Supabase database**. Thus real operational prune remains blocked until that reference-capture/maintenance procedure is validated. Do not supply a fabricated empty inventory for application data.

Safeguards:

- All historical 6,085 IDs are protected, including any copied into the new store. The entire historical directory, including its 90 extra fixtures, is outside the delete path.
- Manual, import, tombstone and import-associated snapshots are retained.
- All supplied references and recovery-catalog members are retained and verified; missing/corrupt references/catalogs refuse the operation.
- At least `keepLatest >= 1` entries per dataset are preserved; only older unreferenced automatic snapshots qualify.
- Full candidate verification precedes approval and deletion. Root, identity and bytes are rechecked during execution. Catalog publication, local saves, exports and prune share a filesystem maintenance lock.
- A private, fsynced intent containing the complete plan precedes any deletion; a fsynced result records removed IDs and completion time. No arbitrary recursive directory deletion or Finder workflow is offered.
- An interrupted prune leaves an unresolved intent and **PRUNE_RECOVERY_REQUIRED** blocks readiness/writes. It is not automatically resumed. This operation is not an atomic multi-object transaction: a crash can leave a partially deleted candidate directory. The intent identifies every approved candidate; preserve it and any surviving files, inspect them against the plan and obtain explicit maintenance approval before reconciling the journal. There is no automatic journal repair/restore command. Intent and result records are retained indefinitely.

Catalog retirement and deletion of historical/import/manual/tombstone snapshots are deliberately unavailable. Those need separate Owner authorization and a reference/restore review; this phase does not weaken their protection to offer a delete button.

## Validation evidence

[LOCAL_VAULT_EVIDENCE.json](LOCAL_VAULT_EVIDENCE.json) records the actual mounted run. No production endpoint or DB was accessed.

| Required behavior | Evidence |
| --- | --- |
| Canonical resolution, mounted startup | Real CLI `init`: VAULT_READY, root exact, historicalCount 6085, activeCount 0 |
| Vault unavailable/no fallback | Unit mount-failure/root-disappearance checks; init/read/write/list fail, missing root stays missing |
| Write, immutable conflict, read/hash | Real isolated Vault fixtures: 3 written, changed duplicate rejected, exact JSON/hash verified |
| Catalog consistency | Synthetic named catalog protects its member; unit corrupt-catalog/missing-reference rejection |
| Restart/recovery | New authority instance reads/verifies existing snapshots, no in-memory state required |
| Prune dry-run | Actual run: 1 candidate, all 3 remain before approval |
| Safe synthetic prune | Approved digest removes only that 1 candidate; catalog-pinned and latest entries remain (2) with durable journal |
| Historical integrity | All 6,085 raw/compressed/metadata checks pass; frozen manifest unchanged |
| Regression | 207 passed, 16 skipped, 0 failed (28 passed suites, 6 skipped) |
| Mounted integration | 1 passed, 0 failed; separate opt-in run, not counted as an ordinary regression pass |
| Typecheck / targeted lint / diff check | Exit 0 |
| Production mutation | None; component has no DB connection/deployment code |

Six new unit tests cover multiple assertions, including private exact-byte export/overwrite refusal, Vercel rejection, corruption, stale references, changed baseline, changed plan, interrupted prune and symlink protection. Existing filesystem tests continue to pass. Two synthetic snapshots and their catalog/journal remain in the recorded isolated fixture root as recovery evidence; no broad cleanup was performed.

## Remaining deployment blockers and next actions

1. Define and validate a **local capture process** against approved staging Supabase data: read-consistent revision/source hash, complete reference extraction, failure reporting and restart checkpoints. Agree backup frequency, offline duration and RPO. This phase exposes the verified local save/read/export primitives; it does not claim continuous capture or snapshot-before-every-Vercel-write behavior.
2. Define ownership/authentication and staging retrieval/restore workflow. Vercel cannot access Vault while the Owner is offline; historical Settings restore/search needs an explicit operator-mediated workflow or separately approved local service. No inbound Vault HTTP server was introduced.
3. Validate the quiesced reference inventory for real prune; retain indefinite snapshots until that gate is met. Test interrupted-prune reconciliation in an isolated environment before any real prune.
4. Optional later durability work: an independent offline backup of Vault plus catalogs/journals. Per the Owner's latest scope, this is **not a staging/deployment blocker**, and no second provider/disk is introduced.
5. Complete the existing application staging build, DB/Auth integration, credentials, dependency-security remediation, Monthly Report Factory assets/worker and smoke-test gates. Remote-provider conditional-write compatibility is no longer a gate in this architecture.
6. Obtain Owner approval before any commit, staging deployment, production mutation or historical migration/deletion. Production remains untested/offline until a real deployment and production smoke test pass.

Current working tree contains mixed pre-existing recovery/application changes plus this local authority work. HEAD remains `5b6f68ac28b9604f9d44b982397e77072aa2ba4a`. No commit, push, deployment, archive migration or production traffic change was performed.
