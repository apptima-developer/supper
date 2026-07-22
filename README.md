# SUPPER Support Control System

Internal support operations system built with Next.js App Router, TypeScript, Tailwind CSS, local Prompt font assets, and pluggable server-side storage.

## Start

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000`.

Use the repository's approved seed/setup process for local accounts. Never deploy seeded credentials; create or change production passwords through the admin UI so the current password policy is enforced.

## Data model

SUPPER supports `local-json`, `supabase`, and `supabase-relational`. The production target is `supabase-relational`: core entities use relational `support_*` tables while approved auxiliary JSON remains in `app_store`. See [data storage architecture](docs/data-storage-architecture.md).

Excel imports use a preview/commit workflow. SupportDesk workbooks read `Customer_MD_Control`, `Issues_Log`, and `Master`; Snow imports use `data/imports/mappings.json`. Imports upsert and never delete missing rows.

Monthly report runtime files remain a documented deployment limitation and are not migrated by Phase 0.2.

## Integration architecture

The provider-neutral integration boundary lives in `src/lib/integrations/`. It defines validated message and ticket envelopes, versioned events, stable idempotency, bounded retry metadata, safe errors, and a generic connector contract.

The Email Intake domain in `src/lib/email-intake/` builds on that boundary with an immutable aggregate, explicit lifecycle, audit history, domain-event objects, duplicate protection, search, and repository adapters for every existing storage backend. It still does not connect to a provider, read or send mail, publish events, schedule work, expose an API, or change UI. See the [integration boundary](docs/integration-boundary.md) and [Email Intake domain](docs/email-intake-domain.md) before extending this foundation.

The isolated `ai_development` Preview includes guarded ServiceNow diagnostics, administrator-triggered read-only Incident synchronization, sanitized operations history, and stable mapping from ServiceNow companies to existing SUPPER customers. It never writes ServiceNow or creates customers automatically. See [AI-development bootstrap](docs/ai-development-bootstrap.md), [ServiceNow integration](docs/servicenow-integration.md), [operations](docs/servicenow-operations.md), and [customer mapping](docs/servicenow-customer-mapping.md).

AI-1.3 adds the relational [Unified Intake Core](docs/unified-intake-core.md) and protected Intake Operations page for future email, LINE, web, and internal intake. It stores channel/identity, conversation, message, attachment metadata, guided-session, idempotency-ledger, Ticket-link, and outbox-intent records. It does not connect to a live provider, create a Ticket or Incident, store attachment bytes, send a message, or run a worker. Existing [Email Intake](docs/email-intake-domain.md) remains unchanged and has a pure compatibility mapper only.

Patch B3.5 makes those boundaries mechanically verifiable, narrows public module surfaces, and adds a read-only active-data integrity check without changing backend routing. See [architecture consolidation](docs/architecture-consolidation.md).

## Production security setup

Before deploying Phase 0.2.1:

1. Apply the reviewed SQL migrations in version order through the Supabase SQL Editor or an approved migration runner: `202607170001_security_foundation.sql`, then `202607170002_security_foundation_corrections.sql`.
2. Configure `SESSION_SECRET`, `RATE_LIMIT_PEPPER`, and `APP_ORIGIN` in the hosting environment.
3. Configure the selected storage backend and its Supabase server credentials.
4. Run the verification commands below.

Details and rollback considerations are in [security foundation](docs/security-foundation.md) and [database migrations](docs/database-migrations.md).

## Verification

```bash
npm test
npm run lint
npm run build
npm run verify:runtime-assets
npm run verify:migrations
npm run verify:architecture
npm run verify:data-integrity
npm run verify:servicenow-sql
npm run verify:intake-core-sql
```

## Operations

Use the public liveness and readiness endpoints for safe deployment diagnostics, then run the non-destructive build and smoke checks:

```bash
npm run verify:build-env
SMOKE_BASE_URL=https://your-deployment.example npm run smoke:test
```

The smoke test calls only `GET /api/health/live`, `GET /api/health/ready`, and `GET /login`. Request correlation, safe response fields, Vercel verification, and rollback guidance are documented in the [operations runbook](docs/operations-runbook.md).
