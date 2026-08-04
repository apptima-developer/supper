# ServiceNow operations

## Scope

AI-1.2 adds an administrator operations layer over the existing manual, read-only ServiceNow Incident synchronization pipeline. It does not schedule work and adds no ServiceNow Incident `POST`, `PATCH`, `PUT`, or `DELETE` operation.

The protected page is **Settings → ServiceNow integration → Open Operations** at `/settings/integrations/servicenow`. An active SUPPER session with `settings:manage` is required by both the page and every operations API.

AI-2.0.8 corrects the separate protected **Write controls** page at `/settings/integrations/servicenow/write`. The read operations documented here remain read-only and unchanged. Live write execution is disabled by default and is documented in [Controlled ServiceNow Write Kernel](servicenow-write-kernel.md).

Write controls distinguish configuration, untested/expired/tested GET proof, live-write switch, and complete live readiness. Manual command submissions retain one server-issued operation identity until success, allowing safe lost-response replay only when the full semantic command material matches. Command detail shows the projected current unresolved candidate and bounded newest-first display history; terminal projection is loaded separately, so a resolution outside the display window remains authoritative. Candidate-aware manual decisions refresh and lock to that current ID. A stuck `executing` Attempt displays its database-derived recovery timestamp; the underlying lease covers every planned provider request plus authentication allowance and grace. Recovery makes no provider request, retains unknown original outcome, and rejects late success or failure through the same bounded conflict path.

## Page architecture

The page has four sections:

- **Overview** displays sanitized configuration state, watermark, recent-run counters, mapping counters, and the existing test/sample/manual-sync actions.
- **Sync Runs** provides bounded filtering and pagination plus sanitized per-record outcomes. It never renders a raw provider response or complete ticket JSON.
- **Customer Mapping** aggregates stable ServiceNow company sources and maps them to an existing active SUPPER customer.
- **Diagnostics** remains collapsed and is available only when the existing AI-development Preview guard permits the diagnostic endpoint. Its `404` behavior is unchanged elsewhere.

Desktop run history uses a compact table; small screens use operation cards. All browser requests go to authenticated SUPPER APIs. ServiceNow and Supabase credentials remain server-only.

## API routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/integrations/servicenow/operations` | Sanitized overview and counters |
| `GET` | `/api/integrations/servicenow/runs` | Filtered, paginated run summaries |
| `GET` | `/api/integrations/servicenow/runs/[runId]` | One run and at most 100 bounded run items |
| `GET` | `/api/integrations/servicenow/customer-mappings` | Aggregated mapping queue |
| `POST` | `/api/integrations/servicenow/customer-mappings` | Apply/change/reactivate one mapping |
| `POST` | `/api/integrations/servicenow/customer-mappings/[mappingId]/deactivate` | Preserve and deactivate one mapping |
| `GET` | `/api/integrations/servicenow/customer-targets` | Search active SUPPER customers |

Queries and JSON bodies use strict Zod schemas and bounded sizes. The mapping POST accepts only `externalCustomerKey` and `customerKey`; provider, company metadata, actor, operation IDs, request/correlation IDs, timestamp, and target name are resolved on the server.

## Run data safety

Run summaries contain fixed-window timestamps, composite watermarks, counters, duration, bounded safe codes, and the secondary audit warning. Run items contain only external Incident number, outcome, source timestamp, optional internal ticket ID, safe error code, and bounded warning code. Descriptions, caller identity, assignment data, raw records, and credentials are excluded.

## Audit semantics

`integration_customer_mapping_events` is the authoritative mapping history and is written in the same database transaction as the mapping and ticket updates. A bounded `support_audit_log` entry is then attempted using the existing application audit pattern. If this secondary write fails, the committed mapping remains successful, the response carries `secondary_audit_write_failed`, and the server emits `SERVICENOW_CUSTOMER_MAPPING_SUCCEEDED_AUDIT_FAILED` with request/mapping IDs only.

## Permissions and limitations

The new relational tables have RLS enabled, no anon/authenticated policy, and service-role-only grants. Every mapping RPC is `SECURITY DEFINER` with an explicit `public, pg_temp` search path and explicit execution revokes from `PUBLIC`, `anon`, and `authenticated`.

Current candidate aggregation is bounded to 10,000 Incident rows and 2,000 mapping rows per request. The UI returns no more than 100 candidates and shows a warning when returned totals may be incomplete. A full canonical source key uses exact server-side lookup and does not depend on the candidate page. No customer is created automatically. Missing-company sources remain visible but cannot be mapped.

Applying a mapping resolves source metadata again on the server. First deactivation reports `deactivated`; repeated or concurrent duplicate deactivation reports `unchanged`, creates no second audit/event, and the toast explicitly says no changes were made.

After AI-1.2.1 acceptance, the next milestone is **AI-1.3 Unified Intake, Identity, Message, and File Core**. LINE OA begins only after that provider-neutral foundation is accepted. This milestone performs no ServiceNow write.

## Manual acceptance

After applying migration `202607210001` to the verified isolated `supper-ai-dev` project, deploy `ai_development`, sign in as an administrator, and open the Operations page. Verify overview counters, the existing connection/sample/manual-sync actions, run filtering/detail, and the bounded-results warning. Map a company, capture complete Ticket JSON/relational `updated_at`/mapping-applied time/event count, then run unchanged incremental sync and confirm every captured value is identical. Change title, state, or priority and confirm only ServiceNow-owned fields move. Verify exact canonical-key search, legacy `externalCustomerId` and `companyExternalId`, explicit remap, deactivation twice (`deactivated`, then `unchanged`), the disabled unknown-company action, and GET-only Incident traffic.
