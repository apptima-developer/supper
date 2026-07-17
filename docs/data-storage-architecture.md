# SUPPER Data Storage Architecture

Phase 0.2 freezes the routing approved in Phase 0.1.1. It does not migrate production data and does not remove a backend.

## Supported modes

| `DATA_BACKEND` | Core business data | Auxiliary JSON | Intended use |
| --- | --- | --- | --- |
| `local-json` | Files under `data/` | Files under `data/` | Local development and compatibility |
| `supabase` | Supabase `app_store` JSONB rows | Supabase `app_store` JSONB rows | Existing hosted compatibility mode |
| `supabase-relational` | Relational `support_*` tables | Supabase `app_store` JSONB rows | Target production architecture |

Core entities include customers, tickets, ticket history, audit records, users, import batches, report jobs, and shared master data. Auxiliary JSON consumers include import mapping overrides and Settings backups. `supabase-relational` intentionally continues to use `app_store` for those auxiliary records.

The routing decision is centralized in `src/lib/storage-routing.ts`. Repositories use relational functions only when core routing resolves to `supabase-relational`; `src/lib/json-store.ts` independently resolves auxiliary storage. Supabase-backed errors remain visible and must never fall back to the Vercel filesystem.

## Entry-point audit

- Pages load data through `src/lib/repositories.ts`, which selects the core repository backend.
- Customer, ticket, user, master, import, audit, and report mutations use the same repository boundary.
- `src/lib/json-store.ts` handles auxiliary JSON reads, atomic writes, backups, and restoration.
- Import mapping overrides use `json-store`; only a genuinely absent optional override may use source defaults.
- Report assets use relational storage only in `supabase-relational`; legacy modes retain their existing behavior.
- Login throttling is separate security state: Supabase modes use `support_login_rate_limits`; local development uses process memory.

Existing routing regression tests cover all three modes, app_store failure propagation, backup listing/restoration, and the absence of local fallback.

## Production target and limitations

`supabase-relational` is the recommended production target for future integrations. Phase 0.2 does not force it and does not run a data migration. Administrators must verify relational row counts before changing `DATA_BACKEND`.

`local-json` is not safe for horizontally scaled or ephemeral production hosts. Its login throttling is in-memory, and its runtime writes are local. Monthly report generation still has documented local template/runtime-file dependencies. Moving report files or future attachments to object storage is explicitly outside this phase.
