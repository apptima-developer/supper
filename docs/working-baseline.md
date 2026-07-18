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
