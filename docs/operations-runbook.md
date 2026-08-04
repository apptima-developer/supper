# SUPPER Operations Runbook

Patch B1 adds lightweight diagnostics without changing authentication, storage, business workflows, or database state.

## Live and ready endpoints

`GET /api/health/live` proves only that the Next.js process can serve the route. It does not authenticate, open data files, inspect report templates, or connect to Supabase. A serving process returns HTTP 200 with the existing application, status, and version fields plus safe runtime metadata.

`GET /api/health/ready` validates runtime configuration without connecting to Supabase or reading production data. It returns HTTP 200 when configuration checks pass and HTTP 503 when one or more checks fail. Check names and messages are sanitized; secret values are never returned.

```bash
curl -i https://example/api/health/live
curl -i https://example/api/health/ready
```

Status meanings:

- `200 live`: the application process can serve the liveness route.
- `200 ready`: required runtime configuration is valid for the selected backend.
- `503 not_ready`: one or more required configuration checks failed; inspect the named checks and deployment environment variable names.

Both health responses return `X-Request-ID`, include the same safe ID in JSON, and include a current server timestamp. They never return hostnames, filesystem paths, credentials, cookies, request bodies, stack traces, customer data, or Supabase service-role values.

## Build verification

Run this before building or deploying:

```bash
npm run verify:build-env
```

The command validates variable presence and format for the selected backend, required runtime report assets, and migration filenames/content structure. It does not connect to Supabase, execute SQL, or write data. Output contains only the check name, `PASS`, `FAIL`, or `OPTIONAL`, and a sanitized explanation.

Required production variable names:

- `DATA_BACKEND`
- `SESSION_SECRET`
- `RATE_LIMIT_PEPPER`
- `APP_ORIGIN`
- `NEXT_PUBLIC_SUPABASE_URL` for `supabase` or `supabase-relational`
- `SUPABASE_SERVICE_ROLE_KEY` for `supabase` or `supabase-relational`

Optional request-limit variables are `MAX_JSON_BODY_KB`, `MAX_IMPORT_FILE_MB`, and `MAX_INLINE_IMAGE_MB`.

AI-2.0.8 corrects optional ServiceNow write controls. `SERVICENOW_WRITE_ENABLED` defaults to false and gates only live provider mutation; the bounded GET readiness test remains available. `SERVICENOW_WRITE_MAX_ATTEMPTS` defaults to 3 and is bounded from 1 through 10. Optional `SERVICENOW_CREDENTIAL_VERSION` is non-secret rotation metadata and defaults to `unversioned`; change it whenever the configured credential changes.

An ambiguous post-dispatch outcome is an operator event, not a retry event. G2 is GET-only and must include request/response marker hashes matching the SQL-computed command-marker hash. Non-create success must show exact PATCH endpoint, final target pair, normalized field list, and strict safe 2xx response. Terminal candidate state comes from its separate terminal projection, not the 100-row display history. Before **Recover stuck Attempt**, wait for the displayed database timestamp: create reserves three full provider timeouts, number-target commands two, `sys_id` commands one, OAuth adds token allowance, and all receive two-minute grace. A late success, provider failure, candidate-bearing proof failure, or internal adapter error is rejected once with safe identifiers/classification only and cannot alter any ledger or Ticket link.

Optional build metadata variables:

- `APP_BUILD_SHA`
- `APP_BUILD_TIMESTAMP`
- `VERCEL_GIT_COMMIT_SHA`
- `VERCEL_ENV`

Invalid optional metadata is omitted. Missing optional metadata never makes readiness fail.

## Smoke test

Run the read-only smoke test against an explicit local or deployed origin:

```bash
SMOKE_BASE_URL=https://example npm run smoke:test
SMOKE_BASE_URL=https://example SMOKE_EXPECT_BACKEND=supabase-relational npm run smoke:test
```

Every request has a finite timeout. The script calls only the two public health routes and the login page, does not authenticate, follows no redirects, and performs no mutation. It prints a concise PASS/FAIL table without response bodies.

## Vercel deployment verification

1. Confirm required production variables are configured for the intended Vercel environment. Do not copy their values into tickets, logs, or documentation.
2. Run `npm ci`, `npm run verify:build-env`, `npm test`, `npm run lint`, and `npm run build` against the release source.
3. Deploy the reviewed commit.
4. Call `/api/health/live`; expect HTTP 200.
5. Call `/api/health/ready`; expect HTTP 200 and the intended backend name. HTTP 503 means configuration must be corrected before operational use.
6. Run `SMOKE_BASE_URL=https://deployment.example SMOKE_EXPECT_BACKEND=<backend> npm run smoke:test`.
7. Confirm the login page renders and perform the approved disposable-account regression check when credentials are available.

## Request correlation and logs

Clients may send `X-Request-ID` using 8-100 ASCII letters, numbers, dots, underscores, or hyphens. Invalid IDs are replaced with a generated UUID. Safe API error responses and health responses return the accepted or generated ID.

Use that ID to correlate a client-visible error with server logs. Structured operational logs may contain timestamp, level, event, request ID, route or operation name, safe error type, and sanitized context.

Logs intentionally do not contain:

- passwords or password hashes
- secrets, peppers, tokens, authorization headers, cookies, API keys, or service-role values
- request bodies or multipart contents
- usernames, email addresses, ticket titles, customer names, report rows, or uploaded file content added by B1 diagnostics
- inline image data, Base64 content, stack traces, or filesystem paths added by B1 diagnostics

## Known limitations

- B1 adds request correlation only to health responses, safe centralized API errors, and practical login responses; it does not refactor every route.
- Readiness validates configuration but deliberately does not query Supabase or production data.
- The smoke test proves public diagnostics and login-page availability only; it does not prove authenticated workflows.
- Existing repository console output outside the structured logger is not replaced by B1.
- Monthly report runtime files retain their existing architecture and limitations.

## Rollback

The Golden Source rollback point for B1 is `supper-source-audit-cdd5c8b.zip` and commit `cdd5c8b`. Roll back by redeploying that reviewed source. B1 introduces no SQL migration or database state, so no database rollback is required. Re-run liveness, readiness, and login-page checks after redeployment.
