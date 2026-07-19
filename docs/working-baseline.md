# SUPPER Working Baseline

Phase: Baseline B0 - Freeze Known-Working Source

## Baseline identity

- Source package: `supper-source-audit-74602e7.zip`
- Verification date: 2026-07-18 (Asia/Bangkok)
- Source Git commit: `74602e79e9e7009ec21b5c503fc4e84d3ad245ff`
- Remote `origin/main` before baseline work: `74602e79e9e7009ec21b5c503fc4e84d3ad245ff`
- Selected local verification backend: `supabase`
- Rollback reference: local branch `backup/pre-working-baseline` at `74602e79e9e7009ec21b5c503fc4e84d3ad245ff`

The supplied archive was extracted into an isolated temporary directory before the existing working application was changed. All 140 files in the archive matched the corresponding files at the source commit byte for byte. No older phase commit was merged or cherry-picked over the supplied source, and no application file replacement was required.

## Required environment

Production requires these variables without committing their values:

- `DATA_BACKEND`
- `SESSION_SECRET` (at least 32 characters)
- `RATE_LIMIT_PEPPER` (at least 32 characters)
- `APP_ORIGIN` (the exact production HTTPS origin)
- `NEXT_PUBLIC_SUPABASE_URL` for a Supabase backend
- `SUPABASE_SERVICE_ROLE_KEY` for a Supabase backend; server-only

Optional request limits are `MAX_JSON_BODY_KB`, `MAX_IMPORT_FILE_MB`, and `MAX_INLINE_IMAGE_MB`. `LIBREOFFICE_PATH` may be required for monthly report PDF export when LibreOffice is not discoverable automatically. No environment value is recorded in this document.

## Verification results

| Command | Exit | Duration | Result and warnings |
| --- | ---: | ---: | --- |
| `npm ci` | 0 | 7.35s | Installed 593 packages. Reported existing transitive deprecation warnings for `inflight`, `rimraf@2`, `lodash.isequal`, `glob@7`, `fstream`, and `uuid@8`. No dependency was changed. |
| `npm test` | 0 | 4.69s | 12 test files passed; 94 tests passed. Vitest execution time was 2.89s. |
| `npm run lint` | 0 | 4.92s | ESLint completed without findings. |
| `npm run build` | 0 | 10.82s | Next.js 16.2.9 Turbopack compiled, completed TypeScript, collected page data with 7 workers, generated 18 static pages, and finalized optimization. |
| `npm run verify:migrations` | 0 | 0.27s | Four migrations are valid, ordered, and uniquely versioned. |
| `npm run verify:runtime-assets` | 0 | 0.22s | All required assets are present. The optional runtime import mapping override was absent, so source defaults remain active. |

The first sandboxed Turbopack build stopped making progress at `Creating an optimized production build ...`. A process sample showed the Next.js/Turbopack workers sleeping without an open Supabase connection or an active read from `data/` or report templates. The required CI retry behaved the same way. A diagnostic Webpack build passed in 19.95s, and the exact `npm run build` then passed outside the sandbox in 10.82s. No application or build configuration was changed to obtain the passing result.

## Migration inventory

These applied migration files remain immutable and were not modified, renamed, reordered, combined, deleted, or executed during B0:

- `202607170001_security_foundation.sql`
- `202607170002_security_foundation_corrections.sql`
- `202607180001_fix_login_rate_limit_rpc_conflict.sql`
- `202607180002_fix_login_rate_limit_rpc_variable_conflict.sql`

## Runtime assets

The minimal audit archive intentionally omitted binary report templates. The isolated verification copy recovered only the approved clean templates already tracked by the current working deployment:

| Asset | SHA-256 | Status |
| --- | --- | --- |
| `templates/reports/manday-summary-template.xlsx` | `6bf1c606328e38e0af6b10a90a0ca6ea6702a0d0c4226546711b0d8d36ffefd9` | Present |
| `templates/reports/support-service-monthly-report-template.xlsx` | `42c3a78481508c16656e082d55bbc0ec3a8ad989b9c175788bffbaccd3440c5b` | Present |

No fake template was generated. No customer workbook or generated report was copied into the isolated source.

## Smoke-test matrix

| Area | Status | Evidence or constraint |
| --- | --- | --- |
| Local liveness | PASS | `GET /api/health/live` returned HTTP 200 with the expected sanitized payload. |
| Local readiness | PASS | `GET /api/health/ready` returned HTTP 200 for the selected `supabase` backend; all sanitized configuration checks passed. |
| Login page | PASS | Local and deployed `/login` rendered successfully. |
| Supabase storage availability | PASS | A read-only key-only probe found all 15 required `app_store` records. No values were returned or recorded. |
| Login authentication | PASS | A disposable local account completed the real form POST, received HTTP 303, and opened the authenticated dashboard. No production credential or privileged-session bypass was used. |
| Protected route guard | PASS | Anonymous local requests to protected screens and notifications returned HTTP 307 to `/login`. |
| Dashboard | PASS | Authenticated page returned HTTP 200 against the disposable fixture. |
| Customer list | PASS | Authenticated page returned HTTP 200. |
| Customer detail | PASS | The disposable customer detail returned HTTP 200. |
| Ticket list | PASS | Authenticated page returned HTTP 200. |
| Ticket detail | PASS | The disposable ticket detail returned HTTP 200. |
| Ticket creation | PASS | Disposable API creation returned HTTP 201 and a computed SLA due date. |
| Ticket update | PASS | Disposable PATCH returned HTTP 200; status mapping and appended log were validated. |
| Account administration | PASS | Authenticated admin page returned HTTP 200; no account mutation was performed. |
| Master data | PASS | Authenticated admin page returned HTTP 200; no master mutation was performed. |
| Import preview | PASS | A generated workbook preview returned HTTP 200 with one parsed ticket; import commit was not called. |
| Notifications | PASS | Authenticated API returned HTTP 200 with the expected response shape. |
| Settings | PASS | Authenticated admin page returned HTTP 200. |
| Backup listing | PASS | Settings loaded the local backup listing; no restore was attempted. |
| Monthly report page | PASS | Authenticated page returned HTTP 200; no export was generated. |

## Source handling

No application files were copied into the repository because the supplied source already matched `origin/main`. The isolated source excluded or did not import:

- `.git`, `node_modules`, and `.next`
- `.env*` values and credentials
- local customer data under `data/`
- generated reports and logs
- temporary files
- binary brand/app icons omitted by the minimal audit package
- report templates until they were recovered through the approved runtime-asset procedure above

Repository-level environment example, runtime templates, and existing UI assets were preserved because the current repository already contained them at the same source commit and they remain required for reproducible setup or runtime behavior.

## Known limitations

- Monthly report generation still uses local runtime paths and workbook templates. This baseline does not introduce object storage or a report worker.
- The optional `data/imports/mappings.json` override was absent in the isolated package; compiled source defaults remain available.
- Production Supabase browser authentication was not repeated because no disposable production credential was supplied. The deployed login page rendered, the Supabase key-only read passed 15/15, the actual isolated login flow passed, and the automated Supabase login/rate-limit tests passed.
- The rollback branch and final baseline tag are local until explicitly pushed by the repository owner.
- Dependency deprecations are recorded but intentionally not upgraded during the freeze.

No integration feature was added. No production SQL was executed. No production data was copied, deleted, restored, or migrated. Authentication, sessions, Origin protection, rate limiting, storage routing, backup restore behavior, request limits, CSP, report logic, Supabase configuration, and Vercel environment variables were not changed.

## Patch B1 - Observability and Safe Diagnostics

Patch B1 starts from the supplied Golden Source `supper-source-audit-cdd5c8b.zip` at source commit `cdd5c8b`. The documented B0 underlying source commit above remains unchanged and is not rewritten. No older phase commit was merged or cherry-picked.

Before B1 source changes, the Golden Source was extracted into an isolated temporary directory. The minimal audit archive intentionally omitted binary report templates, so only the two approved tracked templates documented above were copied into the isolated verification directory. Their SHA-256 values remained `6bf1c606328e38e0af6b10a90a0ca6ea6702a0d0c4226546711b0d8d36ffefd9` and `42c3a78481508c16656e082d55bbc0ec3a8ad989b9c175788bffbaccd3440c5b`.

Pre-modification results:

| Command | Result |
| --- | --- |
| `npm ci` | PASS; 593 packages installed with the previously documented transitive deprecation warnings only. |
| `npm test` | PASS; 12 files and 94 tests. |
| `npm run lint` | PASS. |
| `npm run build` | PASS; Next.js 16.2.9 production build completed. |
| `npm run verify:migrations` | PASS; four ordered migration files verified. |
| `npm run verify:runtime-assets` | PASS; required assets present and the optional runtime mapping override absent. |

The four migration files were recorded before modification and remain immutable:

- `202607170001_security_foundation.sql`: `ac71b277ac035ba61638ad74db64c57a0f7c913bf38fc3ea5a54031c5965ace4`
- `202607170002_security_foundation_corrections.sql`: `3ac900810d716b30e08900f70261f57394ee593024debc9ba0a177482781a89f`
- `202607180001_fix_login_rate_limit_rpc_conflict.sql`: `2336baa83d2768439c5b2ecbfaf8f0270264b8f89808759434b569961911d82f`
- `202607180002_fix_login_rate_limit_rpc_variable_conflict.sql`: `ea4faa2262bdaa8a0d3b7df0b88faa0a7e380167a157b12c0d5406353a159efa`

B1 is limited to request correlation IDs, sanitized health metadata, safe structured logging, non-destructive deployment verification scripts, tests, and operational documentation. It does not change authentication rules, sessions, cookies, Origin protection, login throttling, storage, repositories, backups, imports, tickets, customers, reports, dependencies, database schema, or UI behavior. No SQL is executed and no migration is added.

## Patch B2 - Integration Boundary Skeleton

Patch B2 starts from the supplied Golden Source `supper-source-audit-220ffef.zip` at source commit `220ffef`. The documented B0 and B1 sections above remain append-only and are not rewritten.

Before B2 source changes, the Golden Source was extracted into an isolated temporary directory. The minimal audit archive omitted binary report templates, so only the two approved tracked templates were copied into the isolated verification directory. Their SHA-256 values remained `6bf1c606328e38e0af6b10a90a0ca6ea6702a0d0c4226546711b0d8d36ffefd9` and `42c3a78481508c16656e082d55bbc0ec3a8ad989b9c175788bffbaccd3440c5b`.

Pre-modification results:

| Command | Result |
| --- | --- |
| `npm ci` | PASS; 593 packages installed with the previously documented transitive deprecation warnings only. |
| `npm test` | PASS; 15 files and 111 tests. |
| `npm run lint` | PASS. |
| `npm run build` | PASS outside the restricted sandbox; Next.js 16.2.9 production build completed. The sandboxed run failed only because Turbopack was not permitted to bind its internal local port. |
| `npm run verify:migrations` | PASS; four ordered migration files verified. |
| `npm run verify:runtime-assets` | PASS; required assets present and the optional runtime mapping override absent. |
| `npm run verify:build-env` | PASS for the isolated development `local-json` configuration. |

The four immutable migration checksums remained:

- `202607170001_security_foundation.sql`: `ac71b277ac035ba61638ad74db64c57a0f7c913bf38fc3ea5a54031c5965ace4`
- `202607170002_security_foundation_corrections.sql`: `3ac900810d716b30e08900f70261f57394ee593024debc9ba0a177482781a89f`
- `202607180001_fix_login_rate_limit_rpc_conflict.sql`: `2336baa83d2768439c5b2ecbfaf8f0270264b8f89808759434b569961911d82f`
- `202607180002_fix_login_rate_limit_rpc_variable_conflict.sql`: `ea4faa2262bdaa8a0d3b7df0b88faa0a7e380167a157b12c0d5406353a159efa`

B2 adds only provider-neutral TypeScript/Zod contracts, normalized envelopes, versioned events, stable idempotency, retry metadata, safe errors, an in-memory contract-test adapter, tests, and documentation under the existing source tree. It does not add a live provider, transport, API route, worker, scheduler, queue, webhook, persistence, database change, environment variable, UI change, authentication change, or business feature. B3 was not started.

Post-modification results:

| Command or regression | Result |
| --- | --- |
| `npm test` | PASS; 16 files and 139 tests. |
| `npm run lint` | PASS. |
| `npm run build` | PASS; Next.js 16.2.9 compiled, completed TypeScript checks, generated all static pages, and finalized optimization. |
| `npm run verify:runtime-assets` | PASS; required templates and import mapping sources are present. |
| `npm run verify:migrations` | PASS; the same four ordered migrations remain valid. |
| `npm run verify:build-env` | PASS for the selected local development backend. |
| Disposable smoke test | PASS; liveness, readiness, and login page returned the expected safe responses. |
| Disposable login | PASS; the real form POST returned HTTP 303 and established a session. |
| Authenticated read-only pages | PASS; dashboard, customers, tickets, kanban, reports, settings, accounts, and master data each returned HTTP 200. |

Post-modification migration and report-template SHA-256 values exactly matched the pre-modification values recorded above. No migration was added, removed, renamed, reordered, or edited, and neither report template changed.

The manual regression used an isolated temporary source copy with an empty disposable `local-json` dataset and a disposable administrator account. It did not use or mutate repository data, production data, Supabase, backups, imports, customer records, tickets, master data, accounts, reports, or settings. No test credential or hash was added to the repository.

## Patch B3 - Email Intake Domain and Persistence

Patch B3 starts from the supplied Golden Source `supper-source-audit-9c99d56.zip` at source commit `9c99d56`. The documented B0, B1, and B2 sections above remain append-only; no older patch was replayed.

Before B3 source changes, the Golden Source was extracted into an isolated temporary directory. The minimal audit archive omitted the two tracked binary report templates, so only those approved assets were copied into the disposable verification directory. Their SHA-256 values remained `6bf1c606328e38e0af6b10a90a0ca6ea6702a0d0c4226546711b0d8d36ffefd9` and `42c3a78481508c16656e082d55bbc0ec3a8ad989b9c175788bffbaccd3440c5b`.

Pre-modification results:

| Command | Result |
| --- | --- |
| `npm ci` | PASS; 593 packages installed with the previously documented transitive deprecation warnings only. |
| `npm test` | PASS; 16 files and 139 tests. |
| `npm run lint` | PASS. |
| `npm run build` | PASS; Next.js 16.2.9 production build completed. |
| `npm run verify:migrations` | PASS; four ordered migration files verified. |
| `npm run verify:runtime-assets` | PASS; required assets present and the optional runtime mapping override absent. |
| `npm run verify:build-env` | PASS for the isolated `local-json` development configuration. |

B3 adds an immutable provider-neutral Email Intake aggregate, lifecycle, audit entries, domain-event objects, repository contract, shared search and persistence behavior, and adapters for `local-json`, Supabase `app_store`, and the existing relational storage model. It does not add a provider, transport, API route, UI, event publisher, queue, worker, scheduler, webhook, background process, environment variable, package, SQL migration, or schema change. Detailed design and limitations are in [email-intake-domain.md](email-intake-domain.md).

The four immutable migrations and both report-template assets must retain the checksums recorded above after final verification. No SQL is executed and no production or repository data is read, written, migrated, or deleted by B3 verification.

Post-modification results:

| Command or invariant | Result |
| --- | --- |
| `npm test` | PASS; 18 files and 156 tests. |
| `npm run lint` | PASS without findings. |
| `npm run build` | PASS; Next.js 16.2.9 compiled, completed TypeScript checks, generated 20 static pages, and finalized optimization. |
| `npm run verify:runtime-assets` | PASS; required templates and import mapping sources are present. |
| `npm run verify:migrations` | PASS; the same four ordered migrations remain valid. |
| `npm run verify:build-env` | PASS for the selected local development backend. |
| Migration inventory | PASS; all four SHA-256 values exactly match the pre-modification inventory. |
| Report templates | PASS; both SHA-256 values exactly match the pre-modification inventory. |

The B3 tests cover aggregate immutability and validation, lifecycle transitions, audit history, event objects, processor/retry metadata, stable idempotency, duplicate external-message detection, repository contracts, JSON and relational adapters, backend factory routing, search filters, deterministic sorting, pagination, and explicitly gated test deletion. All persistence tests use in-memory adapters; no Supabase or other network connection is opened.

## Patch B3.5 - Architecture Consolidation and Production Safety

Patch B3.5 starts from Golden Source `supper-source-audit-3bcb4e9.zip` at source commit `3bcb4e93b68f3ee722b156c402ce7c981b7d5e6d`. Previous baseline sections remain unchanged and no older patch is replayed.

The Golden Source baseline passed `npm ci`, 18 test files with 156 tests, lint, the Next.js 16.2.9 production build, migration verification, runtime-asset verification, and isolated `local-json` build-environment verification. Production-data paths, all four migrations, both report templates, and deployment/build configuration were hashed before implementation using external read-only manifests.

B3.5 narrows domain barrels, makes domain-to-infrastructure dependency rules mechanically verifiable, consolidates duplicated pure text-validation primitives, preserves invalid-transition context internally without changing public serialization, moves JSON repository contracts onto real guarded temp-file tests, and adds read-only architecture/data-integrity commands. Backend selection, storage keys, SQL, migrations, environment variables, API routes, UI, authentication, sessions, Origin protection, and business behavior are unchanged.

Detailed boundaries, destructive-operation inventory, verification behavior, manual read-only regression steps, and remaining risks are documented in [architecture-consolidation.md](architecture-consolidation.md). B4 is not started.

Final B3.5 verification passed `npm ci`, 21 test files with 165 tests, lint, the Next.js 16.2.9 production build, runtime assets, migrations, build environment, architecture boundaries, and active-data integrity. An isolated read-only manual regression returned liveness 200, readiness 200, login 200, and anonymous dashboard redirect 307. External pre/post manifests confirmed identical content, size, and modification time for all 337 repository data files; all four migrations, both report templates, the lockfile, and deployment/build configuration also matched exactly. `package.json` changed only for the two new verification commands.
