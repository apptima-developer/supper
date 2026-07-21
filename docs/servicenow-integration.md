# ServiceNow integration

## AI-1.0 scope

The first ServiceNow vertical slice is a server-only diagnostic reader. It can test connectivity, list bounded Incident samples, and read one Incident by `sys_id`. It does not create, update, delete, synchronize, queue, webhook, attach, or persist any ServiceNow record. In particular, diagnostic calls never write `support_tickets` or `app_store`.

Provider code lives under `src/lib/integrations/servicenow/` behind SUPPER's provider-neutral integration contracts. Browser code calls only authenticated SUPPER routes. ServiceNow instance details and credentials are loaded and validated on the server.

## Environment

Configure Vercel **Preview** for `ai_development`, not Production:

```dotenv
APP_ENV=ai-development
AI_ENABLED=true
DATA_BACKEND=supabase-relational
SERVICENOW_ENABLED=true
SERVICENOW_INSTANCE_URL=https://your-pdi.service-now.com
SERVICENOW_AUTH_MODE=basic
SERVICENOW_USERNAME=supper_api
SERVICENOW_PASSWORD=your-preview-secret
SERVICENOW_TIMEOUT_MS=15000
SERVICENOW_PAGE_SIZE=100
SERVICENOW_INCIDENT_TABLE=incident
```

Boolean flags accept only `true` or `false` after lowercasing and removing harmless surrounding ASCII whitespace. Authentication mode is normalized the same way and must be `basic` or `oauth_client_credentials`; aliases such as `yes`, `1`, or `enabled` are rejected. Non-secret URL, username, client ID, numeric, and table-name inputs ignore surrounding whitespace. Passwords and client secrets remain byte-exact and are never trimmed, lowercased, logged, or returned.

In an `APP_ENV=ai-development` Vercel Preview only, an administrator can use **Settings → ServiceNow → Diagnose Configuration**. The guarded endpoint reports presence, normalized flags, hostname-only URL validation, bounded field issues, branch, and a 12-character commit. It returns `404` outside AI development, in production, without a session, or without Settings permission; it never calls ServiceNow or returns credential values.

OAuth client credentials are also supported with `SERVICENOW_AUTH_MODE=oauth_client_credentials`, `SERVICENOW_CLIENT_ID`, and `SERVICENOW_CLIENT_SECRET`. Tokens are validated, cached only in server memory, and refreshed before expiry. Tokens are never persisted.

When `SERVICENOW_ENABLED=false`, SUPPER builds and operates normally. URL validation requires HTTPS, except explicit HTTP localhost test instances. Table names, timeouts, page sizes, credentials, and auth-mode requirements are validated with Zod. No ServiceNow credential uses a `NEXT_PUBLIC_` prefix.

## PDI assumptions

The current isolated PDI uses the dedicated `supper_api` machine user with the temporary `itil` role. Basic authentication is acceptable for this PDI diagnostic milestone only; it is not the preferred production integration mode. OAuth client credentials is the intended hardened path.

The known acceptance Incident is `INC0010001`, short description `Test API integration`.

## Read-only endpoints

- `POST /api/integrations/servicenow/test`
- `GET /api/integrations/servicenow/incidents?limit=10&offset=0`
- `GET /api/integrations/servicenow/incidents/[sysId]`
- `GET /api/integrations/servicenow/diagnostics` (AI-development non-production only)

All routes require a current SUPPER session and `settings:manage` permission. The runtime diagnostics route additionally hides behind the AI-development/non-production guard and otherwise returns generic `404`. The list accepts only bounded `limit`, `offset`, `number`, and `updatedAfter` inputs. A browser cannot supply a table, field list, encoded ServiceNow query, instance URL, authentication mode, or credential.

Requests use correlation IDs, bounded timeout/abort handling, bounded pagination, and a maximum-page guard. Provider 400/401/403/404/409/429/5xx, network, timeout, abort, malformed JSON, and unexpected response shapes map to stable safe error categories.

## Incident data boundary

Only these Incident fields are requested:

`sys_id`, `number`, `short_description`, `description`, `state`, `priority`, `impact`, `urgency`, `company`, `caller_id`, `assigned_to`, `assignment_group`, `category`, `subcategory`, `opened_at`, `resolved_at`, `closed_at`, `sys_created_on`, and `sys_updated_on`.

The adapter normalizes primitive, empty, null, display-value, and reference-object fields into a bounded representation containing provider/external identity, HTTPS record URL, title/description, state and priority attributes, references, category, timestamps, and bounded metadata. It never returns credentials, authorization information, tokens, attachments, journals, work-note history, comment history, arbitrary custom fields, or a raw record dump.

Server logs may contain only provider, operation, correlation/request ID, attempt, duration, status, count, page count, and safe error category. Credentials, tokens, authorization headers, descriptions, caller identity, emails, and complete records are forbidden.

## Preview acceptance

1. Deploy `ai_development` as Vercel Preview with AI-development Supabase and ServiceNow values.
2. Sign in with the guarded AI-development administrator.
3. Open **Settings** and confirm the sanitized host/auth status.
4. Click **Diagnose Configuration** and confirm the displayed branch/short commit match the Preview, both enabled flags are normalized as expected, required credential presence is `Yes`, and configuration validity is `Valid`. If not, correct only the listed safe issue paths in Preview variables and redeploy.
5. Click **Test Connection**.
6. Click **Load Sample Incidents** and confirm `INC0010001` / `Test API integration` appears.
7. Confirm the `support_tickets` row count is unchanged.
8. Repeat the sample load and confirm the count remains unchanged.

## AI-1.1 synchronization boundary

AI-1.1 adds an administrator-triggered Incident synchronization pipeline behind the separate `SERVICENOW_SYNC_ENABLED` switch. AI-1.0 diagnostic routes remain read-only and continue to work when synchronization is disabled. The synchronization route cannot accept a provider URL, table, field list, encoded query, credential, or caller-supplied watermark. It issues ServiceNow `GET` requests only.

Synchronization persistence is supported only with `DATA_BACKEND=supabase-relational`. AI-1.1.1 reconciles historical Excel tickets by canonical Incident number, preserves their SUPPER ID and manual fields, and creates the durable ServiceNow `sys_id` link atomically. Persistent synchronization uses a fixed source window and composite `(sys_updated_on, sys_id)` keyset cursor; only the diagnostic sample route retains bounded offset paging. See [ServiceNow synchronization](./servicenow-sync.md) for conflict rules, schema, ownership matrix, migration procedure, and acceptance flow.
