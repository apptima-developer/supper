# SUPPER Baseline Audit

Phase: 0.2.1 - Close Remaining Security and Storage Gaps (includes the approved Phase 0.2 foundation)

## Supported Storage Modes

SUPPER currently supports three storage modes through `DATA_BACKEND`:

- `local-json`: core business data and auxiliary JSON artifacts read and write files under `data/`. Intended for local development only.
- `supabase`: core business data and auxiliary JSON artifacts read and write JSONB rows in the `app_store` table.
- `supabase-relational`: core business entities read and write relational `support_*` tables. Auxiliary JSON artifacts that have not yet been migrated continue to use Supabase `app_store`.

The application treats core business storage and auxiliary JSON storage as separate routing decisions. In `supabase-relational` mode, the active import mapping override and its Settings backups use `app_store`; legacy core JSON backups are not active restore targets and cannot report a successful relational restore. Supabase-backed modes propagate configuration, connection, and permission failures instead of silently writing local files.

If `DATA_BACKEND` is omitted:

- development and tests default to `local-json`
- production defaults to `supabase`

`SUPABASE_DATA_MODEL=relational` is still recognized for compatibility, but `DATA_BACKEND=supabase-relational` is preferred.

## Required Environment Variables

Always required in production:

- `SESSION_SECRET`: at least 32 random characters. There is no production fallback.
- `RATE_LIMIT_PEPPER`: a separate random value of at least 32 characters.
- `APP_ORIGIN`: exact absolute HTTPS origin for browser mutation protection.

Required only when `DATA_BACKEND=supabase` or `DATA_BACKEND=supabase-relational`:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The service role key is used only by server-side modules. It must not be exposed through browser code or `NEXT_PUBLIC_*` variables.

Optional:

- `LIBREOFFICE_PATH`: explicit LibreOffice binary path for monthly report PDF export.
- `MAX_JSON_BODY_KB`, `MAX_IMPORT_FILE_MB`, `MAX_INLINE_IMAGE_MB`: request limits with documented safe defaults.

## Runtime Assets

Required for monthly report export at runtime:

- `templates/reports/manday-summary-template.xlsx`
- `templates/reports/support-service-monthly-report-template.xlsx`

Import mapping configuration:

- source defaults live in `src/lib/import-mappings.ts`
- in `local-json` mode, an optional runtime override may exist at `data/imports/mappings.json`
- in `supabase` and `supabase-relational` modes, the optional override uses the `imports/mappings.json` key in `app_store`
- only a genuinely missing optional override falls back to source defaults; Supabase failures remain visible

Missing report templates do not affect unit tests or production builds. Monthly report export fails at runtime with an actionable missing-template error if a required template is absent.

Check assets with:

```bash
npm run verify:runtime-assets
```

## Commands

Test:

```bash
npm test
```

Lint:

```bash
npm run lint
```

Build:

```bash
npm run build
```

Runtime asset report:

```bash
npm run verify:runtime-assets
```

Migration structure report:

```bash
npm run verify:migrations
```

## Health Endpoints

No session required:

- `GET /api/health/live`: no external connections; returns application name, status, and version.
- `GET /api/health/ready`: validates runtime configuration without exposing secrets.

The proxy processes safe methods before configuration-dependent Origin evaluation. Liveness therefore remains HTTP 200 without `APP_ORIGIN`, `SESSION_SECRET`, or Supabase access, while invalid readiness configuration produces the route's sanitized HTTP 503 rather than a proxy HTTP 403. Browser mutations, including login, remain Origin-protected.

## Known Limitations

- Monthly report factory still uses local runtime files under `data/reports/monthly` and local Excel templates.
- Generated monthly report exports require the template files listed above.
- Import Center supports source defaults and optional mapping overrides, but production-specific aliases should still be managed carefully outside test fixtures.
- Local JSON storage is retained for development and compatibility; production should use a Supabase backend unless intentionally configured otherwise.
- `supabase-relational` still depends on `app_store` for auxiliary JSON artifacts. Migrating those artifacts to dedicated tables or object storage requires a later explicit phase.

## Safe Local Startup Procedure

1. Copy `.env.example` to `.env.local`.
2. Set a local `SESSION_SECRET` with at least 32 characters.
3. For local JSON mode, set `DATA_BACKEND=local-json`.
4. For Supabase mode, set `DATA_BACKEND=supabase` or `DATA_BACKEND=supabase-relational` and provide Supabase variables.
5. Verify runtime templates when monthly report export is needed:

```bash
npm run verify:runtime-assets
```

6. Start the app:

```bash
npm run dev
```

## Baseline Results

The clean Phase 0.2.1 starting point was `main` at `ed1ef4c5af3b7aa7fe16f9c4f4cd20ed2853c107` (`chore: harden SUPPER data and security foundation`). Before modification, `git pull --ff-only origin main` reported up to date. `npm ci` succeeded; 70 tests in 10 files, lint, the Next.js 16.2.9 production build, runtime asset verification, and migration verification all passed.

Phase 0.2 verification covers:

- storage routing remains unchanged across all three modes.
- strict mutation ownership, session invalidation, password policy, throttling, Origin checks, request/file/image limits, DTO privacy, restore policy, header configuration, and redaction have deterministic tests.
- migration filenames and content structure are verified without executing SQL.
- Unit tests can run from a temporary copy without `data/`.
- SLA business-hour calculations are deterministic in Asia/Bangkok.

Final command counts and build timings are recorded in the delivery summary for the commit because they vary by machine.
