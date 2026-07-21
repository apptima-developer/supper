# ServiceNow customer mapping

## Stable external identity

ServiceNow company display text is not an identity and may be renamed. SUPPER derives exactly one stable source:

1. A 32-character company `sys_id` is lowercased and stored as `servicenow-unmapped:<sys_id>`.
2. A non-empty non-`sys_id` reference is SHA-256 hashed and truncated to 24 lowercase hex characters: `servicenow-unmapped:ref-<hash>`.
3. A missing company becomes `servicenow-unmapped:unknown` and is marked non-mappable.

The canonical TypeScript helper is `customer-identity.ts`. Mapping aggregation resolves older tickets in this order: `serviceNow.externalCustomerKey`, current unmapped `customerKey`, deterministic reconstruction from bounded company metadata, then unknown.

The unknown key is deliberately global only as a fallback. Mapping it would reassign unrelated Incidents with no company, so both API and RPC reject it using `SERVICENOW_UNKNOWN_CUSTOMER_NOT_MAPPABLE`.

## Schema

Migration `supabase/migrations/202607210001_servicenow_customer_mapping_operations.sql` creates:

- `integration_customer_mappings`: one unique `(provider, external_customer_key)` mapping to canonical `support_customers.customer_key`; the target foreign key restricts deletion.
- `integration_customer_mapping_events`: durable created, changed, reactivated, and deactivated events.
- `support_apply_integration_customer_mapping(jsonb)`: atomic create/change/reactivate and linked-ticket reassignment.
- `support_deactivate_integration_customer_mapping(jsonb)`: atomic non-destructive deactivation.
- `support_upsert_servicenow_incident_with_mapping(jsonb)`: same-transaction wrapper over the accepted AI-1.1 reconciliation RPC.
- `support_tickets_servicenow_external_customer_idx`: a partial expression index for bounded linked-ticket remapping.

The migration is forward-only, idempotent where practical, records version `202607210001`, and does not delete or recreate existing business rows.

## Apply and remap behavior

The mapping RPC serializes operations for one provider/source using a transaction advisory lock, rechecks the target customer while it is active, and locks matching ServiceNow tickets. It updates only relational customer identity/timestamps and these JSON properties:

- `customerKey`, `customerName`, `requiresCustomerMapping`
- bounded `serviceNow.externalCustomer*`
- `serviceNow.customerMappingId`, `serviceNow.customerMappingAppliedAt`
- `updatedAt`

Ticket ID, Incident number, creation time, title, status, severity, category, MD, chargeability, non-charge reason, owner/efforts, logs, pauses, notes, links, source hash, and unknown JSON properties are preserved. Tickets from other providers or another external company key are not touched.

Applying the same active mapping is idempotent. Changing the target performs an explicit bulk reassignment and writes a `changed` event. Concurrent administrators cannot create duplicate source mappings because of the unique constraint plus advisory serialization.

## Future synchronization

The repository calls `support_upsert_servicenow_incident_with_mapping` for dry-run and committed sync. The wrapper invokes the proven AI-1.1 reconciliation logic, then applies a valid active mapping in the same transaction when a new/adopted/existing ticket is still unmapped. A manually confirmed non-unmapped customer is preserved during ordinary synchronization. An explicit administrator remap is the only operation that may bulk change those linked tickets.

If a mapping points to a missing/inactive target, it is ignored and the deterministic unmapped source remains. Dry-run reaches the same mapping lookup without writing. Stale/hash/idempotency/cursor/link behavior remains owned by AI-1.1.

## Deactivation

Deactivation sets `active=false`, retains the row, and writes a durable event. Existing ticket assignments do not change. New Incidents for that ServiceNow company return to the deterministic unmapped customer until an administrator reactivates or changes the mapping.

## Manual migration procedure

1. Open Supabase and positively identify the isolated **supper-ai-dev** project/ref. Stop if it is production or uncertain.
2. In SQL Editor, confirm versions `202607200001` and `202607200002` already exist in `support_schema_migrations`.
3. Open `supabase/migrations/202607210001_servicenow_customer_mapping_operations.sql`, review its `begin;`/`commit;`, and paste the complete unchanged file into a new SQL Editor query.
4. Execute it once. Do not use the service-role REST API for DDL.
5. Confirm version `202607210001`, both tables, RLS, constraints/indexes, and the three RPCs exist.
6. Confirm `PUBLIC`, `anon`, and `authenticated` cannot execute the RPCs and `service_role` can.
7. Run the manual Operations-page acceptance flow in the isolated `ai_development` Preview.

No source command in this milestone applies the migration remotely.
