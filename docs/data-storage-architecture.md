# SUPPER Data Storage Architecture

Phase 0.2 freezes the routing approved in Phase 0.1.1. It does not migrate production data and does not remove a backend.

## Supported modes

| `DATA_BACKEND` | Core business data | Auxiliary JSON | Intended use |
| --- | --- | --- | --- |
| `local-json` | Files under `data/` | Files under `data/` | Local development and compatibility |
| `supabase` | Supabase `app_store` JSONB rows | Supabase `app_store` JSONB rows | Existing hosted compatibility mode |
| `supabase-relational` | Relational `support_*` tables | Supabase `app_store` JSONB rows | Target production architecture |

Core entities include customers, tickets, ticket history, audit records, users, import batches, report jobs, and shared master data. Auxiliary JSON consumers include import mapping overrides and their Settings backups. `supabase-relational` intentionally continues to use `app_store` for the active `imports/mappings.json` record and its snapshots.

AI-1.3 Unified Intake is a relational-only integration subsystem. With `supabase-relational`, it uses dedicated `integration_*` and `intake_*` tables and atomic service-role RPCs; it never stores intake records in `app_store` or local JSON. On other backends, pure domain helpers remain available but Unified Intake writes return a safe unavailable error. Existing Email Intake backend routing is unchanged.

AI-2.0.5 ServiceNow Write is also relational-only. Its command, attempt, append-only mutation-candidate, mapping, connection, short-lived readiness-proof, Ticket-link, and immutable reconciliation ledgers use dedicated `servicenow_write_*` tables. `service_role` has read-only table grants; all mutations use validated service-role-only RPCs. Attempt finish is the only candidate writer, and later attempts or reconciliation cannot replace the first pair. SQL recomputes the semantic command hash separately from provider normalization, configuration fingerprint, mapping normalization, provider marker, and normalized payload hash, parses scalar transport fields through bounded exception-safe helpers, and independently validates reconciliation action/result/evidence/command-type/target/candidate/acknowledgment combinations. Database time owns candidate observation, proof, confirmation, retry, and reconciliation chronology. Ledger recovery does not require provider configuration; live mutation still does. The subsystem never stores commands in `app_store` or local JSON and never falls back to the Vercel filesystem.

The routing decision is centralized in `src/lib/storage-routing.ts`. Repositories use relational functions only when core routing resolves to `supabase-relational`; `src/lib/json-store.ts` independently resolves auxiliary storage. Supabase-backed errors remain visible and must never fall back to the Vercel filesystem.

## Entry-point audit

- Pages load data through `src/lib/repositories.ts`, which selects the core repository backend.
- Customer, ticket, user, master, import, audit, and report mutations use the same repository boundary.
- `src/lib/json-store.ts` handles auxiliary JSON reads, atomic writes, backups, and restoration under the centralized backend-aware restore policy.
- Import mapping overrides use `json-store`; only a genuinely absent optional override may use source defaults.
- Report assets use relational storage only in `supabase-relational`; legacy modes retain their existing behavior.
- Login throttling is separate security state: Supabase modes use `support_login_rate_limits`; local development uses process memory.

Existing routing regression tests cover all three modes, app_store failure propagation, backup listing/restoration, and the absence of local fallback. In `supabase-relational`, Settings lists and restores only active auxiliary `imports/mappings.json` snapshots. Legacy core JSON snapshots are inactive because their contents cannot update the active relational `support_*` tables; attempts are rejected with HTTP 409 before any app_store write. Relational import rollback remains a separate snapshot mechanism and is unchanged.

## Production target and limitations

`supabase-relational` is the recommended production target for future integrations. Phase 0.2 does not force it and does not run a data migration. Administrators must verify relational row counts before changing `DATA_BACKEND`.

`local-json` is not safe for horizontally scaled or ephemeral production hosts. Its login throttling is in-memory, and its runtime writes are local. Monthly report generation still has documented local template/runtime-file dependencies. Moving report files or future attachments to object storage is explicitly outside this phase.

Unified Intake attachment rows contain metadata only. `storage_object_key` is an opaque future reference, not a local path or URL, and is not exposed to browsers. No runtime attachment filesystem, object-storage adapter, signed URL, or binary payload exists in AI-1.3.
