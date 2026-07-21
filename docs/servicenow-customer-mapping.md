# ServiceNow customer mapping

## Stable external identity

ServiceNow company display text is not an identity and may be renamed. SUPPER derives exactly one stable source:

1. A 32-character company `sys_id` is lowercased and stored as `servicenow-unmapped:<sys_id>`.
2. A non-empty non-`sys_id` reference is SHA-256 hashed and truncated to 24 lowercase hex characters: `servicenow-unmapped:ref-<hash>`.
3. A missing company becomes `servicenow-unmapped:unknown` and is marked non-mappable.

The canonical TypeScript helper is `customer-identity.ts`. SQL uses the same normalization and SHA-256 algorithm. Both resolve older tickets in this exact order: `serviceNow.externalCustomerKey`, current relational unmapped `customerKey`, `serviceNow.externalCustomerId`, `serviceNow.companyExternalId`, then unknown. An explicit valid key takes precedence over conflicting legacy metadata, so another company or provider is never reassigned through a fallback value.

The unknown key is deliberately global only as a fallback. Mapping it would reassign unrelated Incidents with no company, so both API and RPC reject it using `SERVICENOW_UNKNOWN_CUSTOMER_NOT_MAPPABLE`.

## Schema

Migration `supabase/migrations/202607210001_servicenow_customer_mapping_operations.sql` creates:

- `integration_customer_mappings`: one unique `(provider, external_customer_key)` mapping to canonical `support_customers.customer_key`; the target foreign key restricts deletion.
- `integration_customer_mapping_events`: durable created, changed, reactivated, and deactivated events.
- `support_apply_integration_customer_mapping(jsonb)`: atomic create/change/reactivate and linked-ticket reassignment.
- `support_deactivate_integration_customer_mapping(jsonb)`: atomic non-destructive deactivation.
- `support_upsert_servicenow_incident_with_mapping(jsonb)`: same-transaction wrapper over the accepted AI-1.1 reconciliation RPC.
- `support_get_servicenow_customer_source(text)`: one exact sanitized source lookup independent of the bounded candidate list.
- `support_canonical_utc_iso(timestamptz)`: canonical millisecond UTC JSON datetime formatting.
- `support_servicenow_external_customer_key(text)` and `support_servicenow_ticket_customer_key(text, jsonb)`: shared SQL identity rules.
- `support_tickets_servicenow_external_customer_idx`: a partial expression index for bounded linked-ticket remapping.
- `support_tickets_servicenow_customer_identity_idx`: an exact canonical source identity index.

The migration is forward-only, idempotent where practical, records version `202607210001`, and does not delete or recreate existing business rows.

## Apply and remap behavior

The mapping RPC serializes operations for one provider/source using a transaction advisory lock, rechecks the target customer while it is active, and locks matching ServiceNow tickets. It updates only relational customer identity/timestamps and these JSON properties:

- `customerKey`, `customerName`, `requiresCustomerMapping`
- bounded `serviceNow.externalCustomer*`
- `serviceNow.customerMappingId`, `serviceNow.customerMappingAppliedAt`
- `updatedAt`

Ticket ID, Incident number, creation time, title, status, severity, category, MD, chargeability, non-charge reason, owner/efforts, logs, pauses, notes, links, source hash, and unknown JSON properties are preserved. Tickets from other providers or another external company key are not touched.

Applying the same active mapping is idempotent. Changing the target performs an explicit bulk reassignment and writes a `changed` event. Concurrent administrators cannot create duplicate source mappings because of the unique constraint plus advisory serialization.

Ticket JSON datetimes written by mapping SQL always use canonical JavaScript ISO format such as `2026-07-21T04:05:06.123Z`. The RPC validates that the server-provided `appliedAt` already has millisecond UTC form, uses its parsed `timestamptz` for relational columns, and writes canonical text to Ticket `updatedAt` and `serviceNow.customerMappingAppliedAt`. The Ticket schemas are not weakened to accept PostgreSQL offset or space-separated output.

`customerMappingAppliedAt` means the latest explicit mapping creation, target change, or reactivation. It does not mean “last synchronization time.” Mapping-only synchronization derives it from `integration_customer_mappings.updated_at`.

## Future synchronization

The repository calls `support_upsert_servicenow_incident_with_mapping` for dry-run and committed sync. The wrapper invokes the proven AI-1.1 reconciliation logic, then applies a valid active mapping in the same transaction when a new/adopted/existing ticket is still unmapped. A manually confirmed non-unmapped customer is preserved during ordinary synchronization. An explicit administrator remap is the only operation that may bulk change those linked tickets.

Before updating, the wrapper compares relational customer fields, Ticket customer fields, `requiresCustomerMapping`, canonical source metadata, mapping ID, and mapping-applied time. A fully mapped unchanged replay performs no `support_tickets` update: complete Ticket JSON, relational `updated_at`, Ticket `updatedAt`, and `customerMappingAppliedAt` remain identical. AI-1.1 may still advance external-link observation timestamps. A meaningful Incident title/state/priority change updates ServiceNow-owned fields, restores the existing mapping metadata if the base merge replaced it, and retains the original mapping-applied time without creating a mapping event.

If a mapping points to a missing/inactive target, it is ignored and the deterministic unmapped source remains. Dry-run reaches the same mapping lookup without writing. Stale/hash/idempotency/cursor/link behavior remains owned by AI-1.1.

## Deactivation

The first deactivation sets `active=false`, retains the row, writes one durable event, and attempts one secondary audit. Existing ticket assignments do not change. Repeating it returns `action=unchanged`, creates no event or audit, changes no Ticket, and the UI reports that no change occurred. Advisory and row locks keep concurrent duplicate requests truthful. New Incidents for that ServiceNow company return to the deterministic unmapped customer until an administrator reactivates or changes the mapping.

## Exact lookup and bounded candidates

The operations queue remains bounded for safety and returns `truncated=true` whenever the Ticket or mapping scan reaches its bound or the database reports more rows than returned. The UI warns that totals may be incomplete. Entering a complete canonical `servicenow-unmapped:*` key uses `support_get_servicenow_customer_source` instead of the candidate scan, and mapping application always resolves source ID/name on the server through that exact RPC. Active/inactive mapping-only sources and all four compatibility identity paths are supported; raw Ticket JSON is never returned.

## Manual migration procedure

1. Open Supabase and positively identify the isolated **supper-ai-dev** project/ref. Stop if it is production or uncertain.
2. In SQL Editor, confirm versions `202607200001` and `202607200002` already exist in `support_schema_migrations`.
3. Confirm version `202607210001` is absent. AI-1.2.1 amended this file only because the authoritative milestone states it has never been applied. Stop and investigate if the version is already present.
4. Open `supabase/migrations/202607210001_servicenow_customer_mapping_operations.sql`, review its `begin;`/`commit;`, and paste the complete unchanged file into a new SQL Editor query.
5. Execute it once. Do not use the service-role REST API for DDL.
6. Confirm version `202607210001`, both tables, RLS, constraints/indexes, and all mapping/helper RPCs exist.
7. Confirm `PUBLIC`, `anon`, and `authenticated` cannot execute privileged RPCs and `service_role` can.
8. Run the manual Operations-page acceptance flow: map, snapshot JSON/relational timestamps/events, unchanged replay, meaningful Incident update, legacy ID lookup, deactivation twice, and GET-only ServiceNow traffic.

No source command in this milestone applies the migration remotely.

After AI-1.2.1 acceptance, the next milestone is **AI-1.3 Unified Intake, Identity, Message, and File Core**. LINE OA integration starts only after that provider-neutral foundation is accepted.
