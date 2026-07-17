# SUPPER Security Foundation

Phase 0.2 hardens the existing cookie-authenticated application without adding an integration, worker, queue, or new business workflow.

## Authentication and sessions

- New or changed passwords require at least 12 characters, cannot be whitespace-only, and cannot equal the username or email case-insensitively.
- Existing hashes remain valid until a password is changed. Passwords continue to use bcrypt.
- Missing users, wrong passwords, and disabled accounts share the same authentication failure behavior.
- Session cookies remain 12 hours and use `HttpOnly`, `SameSite=Lax`, `Path=/`, plus `Secure` in production.
- New JWTs contain `authVersion`. Legacy user records normalize to version `1`.
- Password, username, email, role, or active-status changes increment `authVersion`; disabled users and stale versions are rejected when the current user record is checked.
- Browser/admin user DTOs omit password hashes, auth versions, and security metadata.

## Login throttling

Five failed attempts within 15 minutes for the HMAC-hashed normalized identity and client network identifier establish a 15-minute lock. Successful authentication resets the key. A lock returns HTTP 429 with `Retry-After`.

Supabase modes persist the state in `support_login_rate_limits` using the migration RPC so multiple Vercel instances share the limit. The key contains no username or raw IP and uses `RATE_LIMIT_PEPPER`. `local-json` uses process memory for development only and is not horizontally reliable.

## Browser request protection

All `POST`, `PUT`, `PATCH`, and `DELETE` requests pass through the centralized Origin gate in `src/proxy.ts`. Production requires an exact HTTPS `APP_ORIGIN`; development may derive the expected localhost origin. Missing or mismatched origins receive HTTP 403. Safe reads and health GETs remain available under their existing access rules.

JSON routes stream and cap bodies before parsing. The defaults are 512 KiB JSON, 20 MiB per `.xlsx`, and 2 MiB decoded per inline image. Ticket log mutation routes add the Base64 allowance for up to four configured-size images to the ordinary JSON cap; every decoded image is still checked independently. Spreadsheet validation checks extension, supported MIME type, actual buffer size, and ZIP signature. Ticket images allow PNG, JPEG, GIF, and WebP and validate Base64, decoded size, and binary signature.

## Mutation ownership

Browser mutation schemas are strict allowlists. Unknown fields are rejected with HTTP 400 instead of being silently stripped. Ticket identifiers, create/update timestamps, computed due dates, effort totals, logs, SLA pauses, customer keys, audit data, and import metadata remain server-owned. Import/system operations retain separate internal repository paths.

## Headers and CSP

Responses set `nosniff`, strict-origin referrer policy, a restrictive permissions policy, framing denial, and CSP `frame-ancestors 'none'`. HSTS is production-only. CSP allows local/data fonts and local/data/blob images. `style-src 'unsafe-inline'` and `script-src 'unsafe-inline'` are retained for compatibility with the current Next.js/UI runtime; `unsafe-eval` is development-only. Removing the remaining inline exceptions would require a separate nonce/frontend refactor.

## Errors, logs, backup, and restore

Central error responses return a safe message/code and request ID without stacks or filesystem paths. Structured server logging redacts password, hash, token, cookie, authorization, secret, pepper, service-role, Base64, and file-content fields.

Settings restore remains admin-only. Backup keys must match the generated `backups/.../<name>-<timestamp>-<id>.json` shape and cannot traverse paths or select arbitrary app_store keys. Restoration retains the pre-restore snapshot. Audit records contain actor, target, timestamp, and result, not backup contents.

## Production deployment checklist

1. Apply and verify `202607170001_security_foundation.sql` before deploying this code.
2. Set different random values for `SESSION_SECRET` and `RATE_LIMIT_PEPPER`, each at least 32 characters.
3. Set exact HTTPS `APP_ORIGIN` for the deployment environment.
4. Set explicit request limits if the defaults are not appropriate.
5. Confirm Supabase variables exist only in server environment settings; never create a `NEXT_PUBLIC` service-role variable.
6. Run `npm ci`, tests, lint, build, runtime asset verification, and migration verification.
7. Smoke-test login success/failure/lockout, account disable, ticket/customer edits, Excel preview/commit, and an authorized backup restore.

Vercel preview URLs require a deliberate `APP_ORIGIN` for that environment; using the production origin on a preview correctly rejects mutations. Apply database changes first because Supabase-backed login rate limiting intentionally fails closed when its table or RPC is missing.
