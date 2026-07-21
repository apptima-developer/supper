# ServiceNow operations

## Scope

AI-1.2 adds an administrator operations layer over the existing manual, read-only ServiceNow Incident synchronization pipeline. It does not schedule work and adds no ServiceNow Incident `POST`, `PATCH`, `PUT`, or `DELETE` operation.

The protected page is **Settings → ServiceNow integration → Open Operations** at `/settings/integrations/servicenow`. An active SUPPER session with `settings:manage` is required by both the page and every operations API.

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

Current candidate aggregation is bounded to 10,000 Incident rows and 2,000 mapping rows per request. The UI returns no more than 100 candidates. No customer is created automatically. Missing-company sources remain visible but cannot be mapped.

The next milestone is **AI-2.0 Controlled ServiceNow Write Loop**. It must be separately designed and reviewed; AI-1.2 performs no ServiceNow write.

## Manual acceptance

After applying migration `202607210001` to the verified isolated `supper-ai-dev` project, deploy `ai_development`, sign in as an administrator, and open the Operations page. Verify overview counters, the existing connection/sample/manual-sync actions, run filtering/detail, the mapping and remapping preservation flow, deactivation, and the disabled unknown-company action. Repeat incremental sync to confirm idempotency and inspect browser network activity to confirm Incident-table requests remain GET-only.
