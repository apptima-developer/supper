# SUPPER — Staging deployment readiness

2026-10-16. **OWNER_ACTION_REQUIRED**. Required business capture/isolated restore and a real optimized Next.js build pass. The actual Vercel staging origin/environment is not yet configured or verified. No deployment, commit, production access or staging data mutation occurred.

## Minimum capture coverage

Runtime inspected: `repositories.ts`, `relational-store.ts`, `storage-routing.ts`, `auth.ts`, import mappings/rollback, generated report storage and email-intake stores; relational/app_store SQL and all four repository migrations. Selected staging backend must be **supabase-relational**. This retains SUPPER's own user accounts and password hashes; it does not depend on backing up Supabase Auth internals.

The prior ticket-only proof was insufficient. Added one protected full-business bundle through the existing Vault filesystem store. All rows/columns of the following tables were captured and reconstructed in a fresh local PostgreSQL database. This includes empty required tables, rather than silently omitting their existence.

| Required SUPPER dataset | Why needed | Previous ticket capture | Added/verified now |
| --- | --- | --- | --- |
| `support_customers` | Customer/project identity and ticket/customer lookup | No; required before deploy | 1 row |
| `support_tickets` | Core operational work and embedded comments/attachments/SLA state | Yes | 2 complete relational rows, including original business JSON |
| `support_ticket_history` | Ticket audit/history | No; required before deploy | 3 rows |
| `support_audit_log` | Application action audit | No; required before deploy | 10 rows |
| `support_users` including `auth_version` | Login, roles, active state, session invalidation | No; required before deploy | 1 row; hashes remain private on Vault/local DB |
| `support_master_data` | Statuses, SLA, holidays, teams, issue types, categories, priorities, contract types | No; required coverage before deploy | 0 rows, table/schema covered; no defaults were seeded |
| `support_import_batches` | Import bookkeeping and rollback relationships | No; required coverage before deploy | 0 rows |
| `support_import_snapshots` | Existing relational import rollback payloads | No; required coverage before deploy | 0 rows |
| `support_report_jobs` | SUPPER report job/customer/month metadata | No; required coverage before deploy | 0 rows |
| `support_report_assets` | Downloadable generated report bytes, if present | No; required coverage before deploy | 0 rows |
| SUPPER auxiliary `app_store` | Mapping overrides, their backup references, email-intake records | No; required coverage before deploy | 0 rows; explicit accepted keys/prefixes only |

Empty master/report/import tables are the observed staging state, not a claim that business configuration is populated for every feature. Missing import mappings have an existing source-default fallback. Versioned SQL reconstructs tables/indexes/policies/functions locally; the bundle is not a Supabase cluster backup.

Excluded: Supabase managed/Auth/service schemas; transient `support_login_rate_limits`; migration ledger rows (DDL rebuilt from repository SQL). The four required repository migration versions are present in staging, as is `support_record_login_failure` in the exposed API inventory. Staging also records seven later migration versions not present in this checkout: no attempt was made to alter, replay or remove them. Current business-table columns all survived the isolated restore comparison.

Monthly Report Factory source XLSX files/normalized local batches/exports are a separate filesystem feature (`data/reports/monthly`), not Supabase state. They are not silently treated as recovered staging DB data. Template inventory passes. The existing Factory upload/generation code writes local filesystem state and PDF conversion uses LibreOffice: those operations are **not established as usable on Vercel** and are outside the minimum core staging smoke set. Do not claim report-factory production functionality from this readiness result or copy Owner historical report files into a staging deployment without review.

## Capture implementation and evidence

Command (explicit local operation, no scheduling):

```sh
node scripts/staging-business-capture.mjs --staging-only
```

The command requires the Owner-configured staging Project URL to match the approved staging identity anchor; it does not use S3 for storage. HTTP access is GET-only. It checks exact row counts (current limit 1,000 rows per table, fail-closed above that), source schema and user auth-version presence, and verifies that observed source digests stay unchanged across the capture/restore interval. This is an observed stable multi-table read, not an MVCC-consistent transaction; pause application writes during an operator capture.

New local-only backup identifier:

`backups/recovery/business-state-1792120397854-5a11b70f-7ee6-4c9e-b08c-93b194d702d7.json`

Directory:

`/Volumes/Vault/storage/supper/snapshot-archives/local-vault/objects/2026/10/recovery/business-state/ab2e9b0564fcd88e0ca789888535c1838b1ac4a53b66d3365194618f82db2872/`

Raw bytes **12,770**, compressed bytes **2,868**. Raw SHA-256:

`d42ebce0978ce1c51d3c32c9e334ed1a54df4b582a4f944cd2bfa6ad7dcb5242`

Manual category plus immutable named catalog protect this bundle. `backupTarget` can parse its local-only identifier, but `isKnownBackupTarget` and all active web Settings restore allowlists **exclude** it; a unit test verifies that separation. No generic cluster restore is exposed through the web app.

The verified Vault export was restored into **`supper_staging_business_5a11b70f7ee64c9eb08c93b194d702d7`**, a newly created local DB in `supper-recovery-pg17`. Applied repository business/app_store DDL and four migrations only to that fresh DB, then inserted rows exclusively from the export. All business rows/columns matched (typed top-level timestamps normalized to equivalent UTC instants); JSON business payloads were preserved. Ticket/customer join, history/ticket join and effective user/auth-version schema checks passed. No historical archive or existing recovery database was mutated.

Detailed paths, hashes, per-table counts and comparison results: [STAGING_BUSINESS_CAPTURE_EVIDENCE.json](STAGING_BUSINESS_CAPTURE_EVIDENCE.json).

## Approved operational responsibility and retention

**Owner / local SUPPER maintenance process** owns captures. Approved **RPO: 24 hours**, with additional captures **before bulk import** and **before restore**. Automation is explicitly deferred. Use the business-state command for this coverage, not the older ticket-only proof command. Record the returned evidence and verify successful capture before those operations. Unmounted Vault/missed capture means the RPO is not met; do not silently fall back to Vercel or another disk.

Real-data prune execution is now hard-blocked on the canonical Vault root, regardless of a supplied plan digest, pending separately approved complete reference inventory. Synthetic fixture pruning remains testable in isolated test roots. Dry-run planning and protected historic reads remain available. No prune was invoked in this phase. All 6,085 historical snapshots are preserved.

Remote object storage and independent backup are **not current staging/deployment blockers**.

## Configuration and production isolation

- Owner-supplied staging URL/key authenticated against the same approved staging project. No production credentials selected. Requests were staging GETs only.
- Local `.env.supper-staging.local` is ignored, untracked, permission 0600. Two independent random staging `SESSION_SECRET`/`RATE_LIMIT_PEPPER` values were generated locally without printing them. `DATA_BACKEND=supabase-relational`, `SUPPER_EXTERNAL_SNAPSHOTS=0` prepared locally.
- **APP_ORIGIN is still blank**. It must be the exact actual staging HTTPS origin; a placeholder is insufficient for CSRF/login/mutation behavior.
- Vercel environment state is not accessible/verified in this task. Do not claim remote secrets are configured.
- No Vault path/provider/MinIO/S3/encryption-key settings belong in Vercel. Local capture is a separate process. Application external snapshots remain off.
- `NODE_ENV=production` is expected for an optimized staging build; it does not select production data when `DATA_BACKEND` and staging URL/key are explicitly supplied. Vercel target must be Preview/staging, not the existing production deployment.

### Exact Owner action required

1. Choose/confirm the **Vercel staging project and exact public HTTPS staging origin**. Fill `APP_ORIGIN` in local `.env.supper-staging.local` with that origin (no path). Report only project name and public origin in chat, never secrets.
2. In that staging project's **Settings → Environment Variables**, scope to the intended **Preview/staging environment**, not existing production:

| Variable | Value/source |
| --- | --- |
| `DATA_BACKEND` | `supabase-relational` |
| `NEXT_PUBLIC_SUPABASE_URL` | Existing `supper-staging` value from local env file |
| `SUPABASE_SERVICE_ROLE_KEY` | Existing staging value from local env file; server-only sensitive secret |
| `SESSION_SECRET` | Newly prepared local env value; sensitive secret |
| `RATE_LIMIT_PEPPER` | Newly prepared local env value; sensitive secret |
| `APP_ORIGIN` | Exact confirmed staging HTTPS origin |
| `SUPPER_EXTERNAL_SNAPSHOTS` | `0` |

Use Vercel's automatically supplied `VERCEL_ENV=preview`; do not override it with a production label. Do not upload the `.env` file or set any secret with a `NEXT_PUBLIC_` prefix. Optional request-limit variables can use the existing defaults.

3. Set Framework **Next.js**, Root Directory **`.`** (this Git repository root), Install Command **`npm ci`**, and Build Command **`npm run build -- --webpack`** to match the production build actually verified. No deploy button/action yet. Confirm completion so the actual origin/configuration gate can be rechecked before Owner deployment approval.

## Production-equivalent build

Actual Next.js **16.2.9** optimized production build via **`npm run build -- --webpack`**, Node **v24.21.0**, selected staging relational backend, `VERCEL=1`, `VERCEL_ENV=preview`, snapshots off. Executed in an isolated working-tree copy; live `.next` dev server untouched. Independent ephemeral build session/rate-limit secrets and `https://supper-staging.invalid` were used to check build shape; this does **not** validate the missing real origin or Vercel secret configuration.

First build found a genuine Next generated-route-type blocker: optional `Request` arguments on two health handlers. Fixed only those signatures and their two test callers. Final build **exit 0**: compilation, generated route TypeScript validation, page generation and build traces completed. Default Turbopack and Vercel execution were not tested; use the specified matching webpack build command.

[STAGING_BUILD_EVIDENCE.json](STAGING_BUILD_EVIDENCE.json) records build result/location. No dependency modernization or migrations against staging were performed.

Final checks: **208 passed, 16 skipped, 0 failed**; full `tsc --noEmit`, full ESLint, architecture, migration inventory, runtime assets and diff check passed. The actual staging business capture/restore is an additional successful assert-based operator run, not one of the skipped test suites. The final prune-only guard is local maintenance code outside the web build entry points.

## Minimum post-deploy smoke set (prepared, not executed)

1. Verify deployed target belongs to the staging Vercel project and configured Supabase URL fingerprint matches staging. Never use production account/resources.
2. Run existing smoke script with `SMOKE_BASE_URL=<actual staging origin>` and `SMOKE_EXPECT_BACKEND=supabase-relational`: liveness/readiness/login HTML must pass with request IDs.
3. Log in using an active **staging SUPPER account**; verify secure session cookie, dashboard and core navigation (`/tickets`, `/customers`, ticket detail), with staging rows shown.
4. Select a dedicated staging smoke ticket; record its original remark privately. In the authenticated browser at the exact configured origin, PATCH `/api/tickets/<id>` with a harmless unique remark marker. Require success.
5. Reload/re-authenticate or read via `/api/tickets`/ticket detail in a fresh request; marker must persist. Check expected history/audit additions. Then explicitly restore the original remark through the same application API, verify readback and retain audit/history; do not delete evidence or prune.
6. Confirm all mutations occurred only in `supper-staging`. Any auth/origin/write/readback failure blocks acceptance. No post-deploy smoke success is claimed now.

The remaining readiness gate is Owner's actual staging origin/Vercel environment configuration; actual deployment and this smoke run require later approval. Monthly Factory filesystem/PDF behavior remains an explicit unvalidated feature limitation. No production-ready claim.

## Git/commit status

HEAD `5b6f68ac28b9604f9d44b982397e77072aa2ba4a`. Working tree retains the earlier mixed recovery/application changes; currently 15 tracked modified files and 12 untracked directory/file entries. This task adds the business capture command/evidence, local-only parsing regression, readiness/build reports, a canonical-root prune execution guard and two minimal health-route signature fixes. Local env secrets remain ignored. **No commit, push or deploy**.
