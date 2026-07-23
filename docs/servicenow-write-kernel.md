# Controlled ServiceNow Write Kernel

AI-2.0 adds an administrator-operated, server-side write boundary for ServiceNow Incidents. It is available only with `DATA_BACKEND=supabase-relational`, uses the existing server-only ServiceNow credentials, and remains disabled for live provider mutation until `SERVICENOW_WRITE_ENABLED=true`.

This milestone does not connect Unified Intake to automatic ticket creation. It adds no LINE OA or email provider, attachment-byte upload, webhook listener, outbound fanout, Freshservice integration, cron, queue, or background worker.

## Supported commands

All command requests contain a `commandType`, `sourceType`, stable `sourceReference`, optional bounded `maxAttempts`, and a strict type-specific `payload`.

| Command | Required payload | Optional payload |
| --- | --- | --- |
| `create_incident` | `shortDescription`, `description` | `callerId`, `category`, `subcategory`, `impact`, `urgency`, `assignmentGroup`, `contactChannel`, `customer`, `projectCode`, `supperTicketNo`, bounded `externalReferences` |
| `update_incident` | `sysId` or `number`, plus at least one update field | `shortDescription`, `description`, `state`, `impact`, `urgency`, `assignmentGroup`, `customer`, `projectCode` |
| `add_comment` | `sysId` or `number`, `text` | none |
| `add_work_note` | `sysId` or `number`, `text` | none |

Impact and urgency accept only `1`, `2`, or `3`. State accepts only the reviewed values `1`, `2`, `3`, `6`, `7`, and `8`. Unknown fields, control characters, unsafe metadata keys, oversized values, and invalid ServiceNow identifiers are rejected before persistence.

Default normalization maps only explicitly approved fields. Comments map to `comments`; work notes map to `work_notes`. When a command supplies only a ServiceNow number, the server performs an exact bounded number lookup before issuing the write. `externalReferences` are retained as bounded command evidence but are not sent through the default ServiceNow field mapping.

## Idempotency and state

The logical idempotency key is deterministic over the connection, command type, source type, source reference, and target table. The normalized payload is hashed separately.

- The same logical key and the same normalized payload return the existing command without creating duplicate work.
- The same logical key with different normalized material returns a bounded conflict.
- Provider-assigned `sys_id` and number values added after a successful create do not change the original idempotency identity.
- Dry runs do not consume the live attempt budget.

Command states are:

`pending` → `validated` → `dry_run_ready` → `executing` → `succeeded`

Provider failures enter `failed` or `retry_scheduled` according to their safe retry classification and the configured attempt budget. `cancelled` is reserved in the model; AI-2.0 exposes no cancellation action. Retries are manual and bounded. No scheduler or background worker executes `next_retry_at`.

If the provider may have received a mutation but SUPPER cannot safely classify the result, the command remains `executing` and the server emits `SERVICENOW_WRITE_EXECUTION_STATE_UNCERTAIN`. Operators must reconcile the target in ServiceNow before taking further action; the kernel will not blindly retry an uncertain mutation.

## Storage and security

Migration `supabase/migrations/202607230001_servicenow_write_kernel.sql` creates:

- `servicenow_write_connections`
- `servicenow_write_mappings`
- `servicenow_write_commands`
- `servicenow_write_attempts`
- `servicenow_ticket_links`

Every table has RLS enabled and no browser policy. Table access and the three privileged write RPCs are revoked from `PUBLIC`, `anon`, and `authenticated`, then granted only to `service_role`. RPCs are `SECURITY DEFINER`, use a controlled search path, and atomically enforce deduplication and state transitions.

Connection rows contain only non-secret configuration. Passwords, OAuth secrets, authorization headers, raw provider bodies, attachment bytes, and full response bodies are never persisted or returned to the browser.

Browser-safe command details expose only:

- command status, bounded identifiers, timestamps, and attempt counters;
- normalized field names, value lengths, and reviewed identifier/enum values;
- request method, endpoint path, table, field names, and safe target identifiers;
- response HTTP status and selected `sys_id`, number, or state values;
- bounded safe error codes and messages.

The command and attempt ledger is the authoritative execution audit. A normal application audit row is attempted after the atomic command operation. If that secondary audit fails, the committed command result remains successful, the response includes `secondary_audit_write_failed`, and a sanitized critical server event is emitted.

## Configuration

Reuse the existing server-only ServiceNow settings and add:

```dotenv
SERVICENOW_WRITE_ENABLED=false
SERVICENOW_WRITE_MAX_ATTEMPTS=3
```

`SERVICENOW_WRITE_ENABLED` defaults to false. The maximum attempt value must be between 1 and 10. Do not expose either ServiceNow credential through a `NEXT_PUBLIC_` variable.

## Apply the migration

Apply this migration only to the verified isolated `supper-ai-dev` project during AI-2.0 acceptance. Do not apply it to production and never edit it after it has been applied.

1. Confirm migrations `202607220001` through `202607220004` are present in `support_schema_migrations`.
2. Take the normal dev database recovery checkpoint.
3. From the exact source revision, run `npm run verify:migrations`, `npm run verify:architecture`, and `npm run verify:servicenow-write-sql`.
4. In the dev Supabase SQL Editor, paste and execute the complete unmodified `202607230001_servicenow_write_kernel.sql`.
5. Confirm the migration row, RLS flags, and grants with the queries below.

```sql
select version, description
from public.support_schema_migrations
where version = '202607230001';

select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in (
    'servicenow_write_connections',
    'servicenow_write_mappings',
    'servicenow_write_commands',
    'servicenow_write_attempts',
    'servicenow_ticket_links'
  )
order by relname;

select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in (
    'support_create_servicenow_write_command',
    'support_begin_servicenow_write_attempt',
    'support_finish_servicenow_write_attempt'
  )
order by routine_name, grantee;
```

Expected: one migration row, RLS true for all five tables, and only `service_role` execution for the three write RPCs.

## Manual smoke test

1. Deploy the reviewed `ai_development` commit to the isolated Preview with `DATA_BACKEND=supabase-relational`, existing ServiceNow configuration, and `SERVICENOW_WRITE_ENABLED=false`.
2. Sign in as an administrator and open **Settings → ServiceNow integration → Write controls**.
3. Confirm the readiness panel reports configured relational storage and that live write is blocked.
4. Compose each command type with a unique stable source reference. Validate it and inspect the mapping preview; long text must appear only as a character count.
5. Run dry runs. Confirm `dry_run_ready`, a durable dry-run attempt, no ServiceNow mutation, and unchanged live attempt count.
6. Submit the same source reference and payload again; confirm the existing command is returned. Change mapped material while retaining the source reference; confirm a conflict.
7. Enable `SERVICENOW_WRITE_ENABLED=true` only in the isolated Preview, redeploy, and use **Test readiness**.
8. Execute one approved disposable Incident command through the explicit confirmation dialog. Confirm the safe response summary, target link, command history, and ServiceNow result.
9. Exercise manual retry only with a deliberately retryable dev failure and confirm the attempt budget is enforced.
10. Disable the write switch after acceptance.

Do not paste credentials, provider response bodies, customer content, or production identifiers into acceptance evidence.
