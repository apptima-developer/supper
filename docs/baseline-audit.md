# SUPPER Baseline Audit

Phase: 0.1.1 - Reproducible Baseline and Auxiliary Storage Correction

## Supported Storage Modes

SUPPER currently supports three storage modes through `DATA_BACKEND`:

- `local-json`: core business data and auxiliary JSON artifacts read and write files under `data/`. Intended for local development only.
- `supabase`: core business data and auxiliary JSON artifacts read and write JSONB rows in the `app_store` table.
- `supabase-relational`: core business entities read and write relational `support_*` tables. Auxiliary JSON artifacts that have not yet been migrated continue to use Supabase `app_store`.

The application treats core business storage and auxiliary JSON storage as separate routing decisions. In `supabase-relational` mode, import mapping overrides, Settings backups, backup restoration, and any remaining `json-store` consumers must use `app_store`; they must never fall back to the Vercel filesystem. Supabase-backed modes propagate configuration, connection, and permission failures instead of silently writing local files.

If `DATA_BACKEND` is omitted:

- development and tests default to `local-json`
- production defaults to `supabase`

`SUPABASE_DATA_MODEL=relational` is still recognized for compatibility, but `DATA_BACKEND=supabase-relational` is preferred.

## Required Environment Variables

Always required in production:

- `SESSION_SECRET`: at least 32 random characters. There is no production fallback.

Required only when `DATA_BACKEND=supabase` or `DATA_BACKEND=supabase-relational`:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The service role key is used only by server-side modules. It must not be exposed through browser code or `NEXT_PUBLIC_*` variables.

Optional:

- `LIBREOFFICE_PATH`: explicit LibreOffice binary path for monthly report PDF export.

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

## Health Endpoints

No session required:

- `GET /api/health/live`: no external connections; returns application name, status, and version.
- `GET /api/health/ready`: validates runtime configuration without exposing secrets.

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

Verified in this phase:

- `npm test` passes.
- `npm run lint` passes.
- `npm run build` completes beyond page-data collection.
- Unit tests can run from a temporary copy without `data/`.
- SLA business-hour calculations are deterministic in Asia/Bangkok.
