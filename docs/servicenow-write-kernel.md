# Controlled ServiceNow Write Kernel

AI-2.0.7 is an administrator-operated, server-only write boundary for ServiceNow Incidents. It requires `DATA_BACKEND=supabase-relational`, reuses server-only ServiceNow credentials, and keeps live provider mutation disabled until `SERVICENOW_WRITE_ENABLED=true`.

This milestone does not connect Unified Intake to automatic creation. It adds no LINE OA or email provider, attachment upload, outbound webhook, Freshservice write, queue, cron, scheduler, or worker.

## Commands and identity

Every command has separate identity fields:

- `sourceType` identifies the originating domain.
- `sourceEntityReference` identifies the canonical SUPPER Ticket, Intake conversation, or outbox row. It is optional bounded context for manual commands.
- `operationReference` identifies one immutable domain operation. A manual command first obtains a signed, five-minute operation token from `POST /api/integrations/servicenow/write/manual-operation`. The token binds the generated operation reference to user, command type, manual source context, environment, and expiry.

The browser retains that token until command creation succeeds. If the first command response is lost, resubmitting identical material with the same token returns the existing command and preserves one provider marker. Changed material conflicts with `SERVICENOW_WRITE_IDEMPOTENCY_CONFLICT`; an expired, differently scoped, or caller-invented identity is rejected. Starting a genuinely new manual operation explicitly obtains a new token.

The v2 logical key hashes the version, connection, command type, operation reference, source type, source entity reference, and target table. Different operation identities allow multiple updates, comments, or work notes on the same Ticket.

Two independent immutable hashes protect different boundaries. `command_material_hash` is the semantic SUPPER request identity: schema version, connection, mapping, command/source/operation identity, target table, the complete validated original payload including `externalReferences` and `supperTicketNo`, and the resolved `maxAttempts`. It deliberately excludes generated transport material such as command/request/correlation IDs and timestamps. `normalized_payload_hash` covers only the exact reviewed provider mutation produced by the active mapping. TypeScript and PostgreSQL build both values independently and share fixed parity vectors. A replay is unchanged only when the full command material matches.

| Command | Required payload | Optional payload |
| --- | --- | --- |
| `create_incident` | `shortDescription`, `description` | reviewed Incident fields and bounded external evidence |
| `update_incident` | exactly one of `sysId` or `number`, plus an update field | reviewed update fields |
| `add_comment` | exactly one of `sysId` or `number`, `text` | none |
| `add_work_note` | exactly one of `sysId` or `number`, `text` | none |

`callerId`, `assignmentGroup`, and `customer` accept only lowercase 32-character ServiceNow `sys_id` values. Updates and journals reject both-target and no-target requests.

## Mapping boundary

Mappings are exact reviewed documents, not arbitrary aliases:

- create: `short_description`, `description`, `caller_id`, `category`, `subcategory`, `impact`, `urgency`, `assignment_group`, `contact_type`, `company`, and `u_project_code`;
- update: `short_description`, `description`, `state`, `impact`, `urgency`, `assignment_group`, `company`, and `u_project_code`;
- comment: `comments` only;
- work note: `work_notes` only.

All required entries must be present. Extra sources, alternate targets, duplicate targets, cross-journal fields, and reserved/system fields are rejected by TypeScript and SQL. Only one mapping can be active for each connection and command type.

Create commands always receive the server-owned marker `SUPPER:<logical-idempotency-key>` in `correlation_id`. User payload and mappings cannot remove or override it. Before every create POST, the adapter performs one bounded exact marker lookup:

- no match permits POST;
- one match recovers the Incident and performs no POST;
- multiple matches require reconciliation.

When the lookup returns no row, the adapter sends exactly one POST, parses only the bounded candidate `sys_id` and Incident number, and immediately performs a second exact GET with the same correlation marker. Success requires exactly one returned row whose marker, `sys_id`, and number all equal the request marker and POST candidate. Missing, ambiguous, conflicting, malformed, timed-out, network-failed, or HTTP 5xx verification becomes `may_have_committed` in the `read_back` phase with retry disabled. Discovery never sends a second POST.

Every valid pair returned by POST is appended as an immutable **mutation candidate event** tied to its Attempt and Attempt number, with its safe HTTP status, database observation time, fixed source `mutation_response`, and proof status. It is not a confirmed ServiceNow target. The Attempt retains only the bounded candidate pair/status and proof flag, never the raw response. Reconciliation resolves one specific event; after candidate A is verified not applied and a retry is authorized, candidate B is appended without rewriting A. An unresolved prior candidate blocks another candidate. Detail projection considers only terminal `confirmed_succeeded` and `confirmed_not_applied` events, selects the newest terminal event for each candidate, and keeps display history newest-first. Inconclusive, not-found, ambiguous, and read-back-failed observations cannot overwrite a terminal resolution, so command detail, the current candidate, and confirmation scope remain consistent.

Create success has two non-interchangeable proof paths. G1 requires POST candidate evidence plus `postWriteMarkerVerified=true`, `proofStatus=marker_verified`, and the exact same marker/`sys_id`/number pair. G2 is exact correlation-marker recovery before mutation: it requires a GET of the reviewed Incident endpoint classified as `correlation_marker_exact`, request and response target pairs that match exactly, a safe 2xx status, `exactMarkerVerified=true`, `recoveredByCorrelationMarker=true`, and `providerWritePerformed=false`. G2 permits no candidate event or POST/PATCH evidence in the current Attempt. Missing identity, a forged or mismatched pair, false/missing exact proof, arbitrary request shape, or mixed G1/G2 material cannot become success. An uncertain candidate must explicitly carry `postWriteMarkerVerified=false`.

Every provider lookup verifies the returned lookup key before using an identity. Number queries require the same returned number, marker queries require the same returned `correlation_id`, and direct record reads require the same returned `sys_id`. When a number resolves both identifiers, both must come from that one row and any later read must preserve that exact pair. A missing or mismatched key returns `SERVICENOW_WRITE_LOOKUP_MISMATCH`; no POST or PATCH follows.

`supperTicketNo` is evidence only and is never the provider idempotency marker.

## Mutation outcomes

The ledger records both a delivery disposition and failure phase.

Delivery dispositions are `definitely_not_sent`, `definitely_rejected`, `safe_to_retry`, `confirmed_succeeded`, and `may_have_committed`. Failure phases are `configuration`, `authorization`, `number_lookup`, `mutation_dispatch`, `mutation_response`, `response_parse`, and `read_back`.

Once POST or PATCH dispatch begins, timeout, network disconnect, abort, HTTP 5xx, malformed/empty/oversized 2xx, invalid returned identity, and failed post-create marker proof are `may_have_committed`. The attempt finishes as `uncertain`; the command enters `reconciliation_required`; `retry_allowed` is false; and `next_retry_at` is empty. Journal uncertainty follows the same rule.

Only a definitive `safe_to_retry` outcome can become `retry_scheduled`, and only while attempts remain. Retry also requires the live-write switch, a due `next_retry_at`, and a fresh server confirmation. `failed`, `reconciliation_required`, `succeeded`, `executing`, `cancelled`, and exhausted commands cannot retry.

## Confirmation and reconciliation

Live execute, retry, and reconciliation require a server-issued confirmation:

```json
{
  "confirmed": true,
  "expectedVersion": 3,
  "expectedNormalizedPayloadHash": "<64 lowercase hex>",
  "confirmationNonce": "<server-issued nonce>",
  "mutationCandidateEventId": "sn-candidate-<64 lowercase hex>"
}
```

The nonce expires after two minutes, is stored only as a hash, is scoped to command/action/user/version/hash and the current unresolved candidate event when present, and is consumed atomically. Stale candidate IDs, command versions, or replayed confirmation material are rejected. Dry-run requires no confirmation and consumes no live attempt.

Administrators with `settings:manage` may:

- `reconcile_by_read_back`: read only; create uses the exact marker, update compares reviewed fields by exact `sys_id`, and journals remain inconclusive without a reviewed journal verification method;
- `mark_succeeded_after_verification`: requires lowercase 32-character `verifiedTargetSysId`, a bounded `verifiedTargetNumber`, a bounded evidence note, and explicit acknowledgment;
- `mark_not_applied_after_verification`: requires a bounded evidence note and explicit acknowledgment, then permits a bounded manual retry when attempts remain.
- `recover_stuck_attempt`: available only while a command and its latest Attempt are still `executing` and the database-owned recovery lease has elapsed; it performs no ServiceNow request, closes the Attempt as `uncertain`, moves the command to `reconciliation_required`, and appends immutable recovery history.

The following matrix is enforced independently by TypeScript and the immutable SQL validator `support_validate_servicenow_reconciliation_evidence`:

| Action | Result | Evidence | Target / acknowledgment |
| --- | --- | --- | --- |
| read back | `confirmed_succeeded` | `provider_matched` | exact complete pair |
| read back | `not_found` | `provider_not_found` | no pair; stays unresolved |
| read back | `ambiguous` | `provider_ambiguous` | no pair; stays unresolved |
| read back | `inconclusive` | `provider_inconclusive` | exact pair; stays unresolved |
| read back | `read_back_failed` | `provider_unavailable` or `provider_target_conflict` | no pair; stays unresolved |
| mark succeeded | `confirmed_succeeded` | `provider_matched`, `provider_target_matched_manual_verification`, or `provider_unavailable_manual_verification` | exact pair, evidence note, acknowledgment |
| mark not applied, create/update | `confirmed_not_applied` | `provider_not_found` or `provider_unavailable_manual_verification` | no pair, evidence note, acknowledgment |
| mark not applied, journal | `confirmed_not_applied` | `journal_manual_verification` | no pair, evidence note, acknowledgment, duplicate-journal-risk acknowledgment |

`provider_inconclusive` means ServiceNow identified the exact Incident but the reviewed mutation content did not match completely. It is neither a provider match nor proof of absence, so it cannot produce `retry_scheduled`. Provider `not_found` blocks success; provider match, ambiguity, conflict, and inconclusive evidence block Mark Not Applied. `provider_unavailable` describes an automatic read-back failure only; the manual variant is used only after explicit administrator verification. Journal review never claims provider absence or unavailability and performs no provider mutation.

For create, an exact marker match and every successful manual decision must agree with the persisted mutation candidate when one exists. A different `sys_id` or number returns `SERVICENOW_WRITE_MUTATION_CANDIDATE_CONFLICT`, remains unresolved, and creates no Ticket link. Provider-unavailable manual success is allowed only for the exact candidate pair. Mark Not Applied for a create candidate displays the known identity and requires `mutationCandidateRiskAcknowledged=true` because a retry may create a duplicate. For update and journal commands, successful finish, read-back reconciliation, and manual verified success preserve the original normalized target: an original `sys_id` cannot change and an original number cannot change. ServiceNow may safely add only the missing counterpart. A conflict returns `SERVICENOW_WRITE_TARGET_CONTINUITY_CONFLICT` before command target or Ticket-link mutation. Journal presence cannot be proven by ordinary GET, so the UI requires the separate duplicate-risk acknowledgment and never replays it automatically.

Ledger recovery is provider-independent. At Attempt begin, SQL derives immutable `recoverable_at` from `statement_timestamp()`, the active connection timeout, and at least two minutes of safety grace, with a bounded maximum delay. Neither the browser nor the service supplies recovery time. Confirmation issuance and recovery both reject before that lease; the UI shows the safe eligible timestamp/countdown, disables recovery, and refreshes command version/hash/candidate immediately before confirmation and action. Recovery evidence states only `recoveredByAdministrator=true`, `recoveryOperationProviderRequestPerformed=false`, and `originalMutationOutcome=unknown`: the recovery action made no provider request, while the original mutation outcome remains unknown.

Command lists/details/history, confirmation issuance, explicit manual decisions, and eligible stuck-Attempt recovery require relational storage but do not require a ServiceNow URL, credentials, or adapter. Execute, retry, creation, readiness, and provider read-back still require valid provider configuration. Reconciliation performs GET only, never repeats the POST/PATCH mutation, creates at most one matching Ticket link, and appends an immutable event that references the candidate event it resolved. The evidence note itself is validated but not copied into the safe history summary. A provider response arriving after administrator recovery cannot rewrite the recovered Attempt, command, candidate history, or Ticket links; it returns bounded `SERVICENOW_WRITE_ATTEMPT_ALREADY_RECOVERED` and emits a sanitized identifier-only late-response log.

## Storage and security

Migration `supabase/migrations/202607230001_servicenow_write_kernel.sql` creates:

- `servicenow_write_connections`
- `servicenow_write_mappings`
- `servicenow_write_commands`
- `servicenow_write_attempts`
- `servicenow_write_mutation_candidate_events`
- `servicenow_ticket_links`
- `servicenow_write_reconciliation_events`
- `servicenow_write_attempt_recovery_events`
- `servicenow_write_readiness_proofs`

All tables have RLS and no browser policy. `service_role` may read them but receives no direct insert, update, or delete grants. Configuration and mapping upserts, command creation, confirmation issuance, attempt transitions, candidate persistence, ticket-link completion, recovery, and reconciliation occur only through reviewed `SECURITY DEFINER` RPCs with controlled search paths. Candidate and recovery tables are append-only; Attempt finish is the only candidate writer. Attempt finish is atomic and idempotent for identical terminal material, while different terminal material conflicts. SQL recomputes logical identity, full command material hash, normalized payload, marker, and normalized payload hash from raw command material and the active mapping. Reconciliation events persist the explicit evidence classification and referenced candidate event, and their bounded safe summary must carry the same classification.

Database rows are parsed with strict Zod schemas before presentation. Browser-safe output never includes credentials, authorization headers, raw provider bodies, original payloads, or long narrative values.

## Readiness

Readiness reports configuration validity separately from proof state. The bounded GET-only test remains available while `SERVICENOW_WRITE_ENABLED=false` and records a sanitized five-minute proof containing connection ID, a non-secret configuration fingerprint, test/expiry times, outcome, safe HTTP status/error code, and actor ID. The fingerprint covers normalized hostname, Incident table, auth mode, and optional non-secret configuration version. It never contains a password, client secret, token, or authorization header.

`liveWriteReady` requires relational storage, valid configuration, the live switch, and a fresh successful proof whose fingerprint matches the current connection. Connection or mapping changes invalidate the proof. Execute and retry enforce the proof both in the application and in the attempt RPC before any attempt row or provider mutation. Missing, expired, failed, or mismatched proof returns `SERVICENOW_WRITE_READINESS_REQUIRED` without consuming an attempt.

Every write RPC parses JSON timestamps, integers, and booleans through guarded SQL helpers. The database `statement_timestamp()` is authoritative for readiness freshness, two-minute confirmations, retry availability, attempt storage, and reconciliation chronology. Caller timestamps must remain within a documented two-minute transport skew and cannot extend any lifetime; successful readiness is stored for exactly five database-clock minutes. Impossible dates, overflow, malformed types, invalid bounds, and chronology violations return bounded application codes rather than PostgreSQL cast details.

## Configuration

```dotenv
SERVICENOW_WRITE_ENABLED=false
SERVICENOW_WRITE_MAX_ATTEMPTS=3
SERVICENOW_CREDENTIAL_VERSION=unversioned
```

The attempt limit is 1 through 10. `SERVICENOW_CREDENTIAL_VERSION` is optional, non-secret rotation metadata; change it when the configured credential changes so old readiness proof cannot authorize the new configuration. No ServiceNow secret may use a `NEXT_PUBLIC_` name.

## Migration strategy

`202607230001` was amended through AI-2.0.7 before first remote application. Evidence: the audited baseline contained the file only locally, every preceding delivery explicitly deferred manual SQL execution, and no remote SQL command was run. This correction also explicitly forbids remote application until review. If the version is present on any target, stop; do not run the amended file or edit applied history. Create and review a forward-only `202607230002` correction instead.

Manual application to the isolated `supper-ai-dev` project only:

1. Verify `202607220001` through `202607220004` exist and `202607230001` does not.
2. Take the normal development recovery checkpoint.
3. Run the full acceptance suite from the exact reviewed source revision.
4. Paste and execute the complete `202607230001_servicenow_write_kernel.sql` once in the isolated development SQL Editor.
5. Verify version, RLS, grants, and RPC privileges:

```sql
select version, description
from public.support_schema_migrations
where version = '202607230001';

select relname, relrowsecurity
from pg_class
where relnamespace = 'public'::regnamespace
  and relname like 'servicenow_write_%'
order by relname;

select table_name, privilege_type
from information_schema.role_table_grants
where grantee = 'service_role'
  and table_schema = 'public'
  and table_name like 'servicenow_write_%'
order by table_name, privilege_type;

select routine_name, grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'public'
  and routine_name in (
    'support_upsert_servicenow_write_connection',
    'support_upsert_servicenow_write_mapping',
    'support_record_servicenow_write_readiness',
    'support_create_servicenow_write_command',
    'support_issue_servicenow_write_confirmation',
    'support_begin_servicenow_write_attempt',
    'support_finish_servicenow_write_attempt',
    'support_reconcile_servicenow_write_command',
    'support_recover_servicenow_write_attempt'
  )
order by routine_name, grantee;
```

Expected: one migration row; RLS on all write-kernel tables; `service_role` table access is select-only; and privileged RPC execution belongs only to `service_role`.

## Preview smoke test

1. Deploy the reviewed `ai_development` revision to the isolated Preview with relational storage and live writes disabled.
2. Sign in as an administrator and open **Settings → ServiceNow integration → Write controls**.
3. Confirm connection testing is available, live mutation is blocked, and **Test readiness** performs a GET successfully.
4. Create separate manual commands for all four command types. Verify exact target validation, safe preview field names, and hidden narrative values.
5. Run dry-runs and confirm no provider mutation and no live attempt consumption.
6. Submit one manual command, simulate a lost HTTP response, and submit the same browser operation again. Confirm one command and one unchanged marker. Change description, `externalReferences`, `supperTicketNo`, target, or `maxAttempts` while retaining that operation and confirm conflict. Change only request/command transport IDs and confirm an unchanged replay; then choose **Start a new operation** and confirm a new command.
7. Enable live writes only on the isolated Preview and redeploy.
8. Execute one disposable create after the server confirmation. Confirm one pre-POST marker GET, exactly one POST, one post-POST marker GET, and success only after the same marker/`sys_id`/number are proven.
9. Simulate a definitive safe retry condition and confirm Retry appears only for `retry_scheduled`.
10. Simulate missing, ambiguous, conflicting, timed-out, malformed, and HTTP 5xx post-create proof. Confirm `reconciliation_required`, `failurePhase=read_back`, the POST candidate/status are visible but not labelled confirmed, no next retry, no Retry button, and no second POST.
11. Reconcile candidate A against exact A and confirm one Ticket link. Reconcile A against a different `sys_id`, number, an ambiguous marker, then a later single row B; confirm every conflict stays unresolved and creates no link. Mark A not applied, retry, and confirm B is appended while A and its resolution remain visible.
12. Exercise every documented action/evidence combination. Confirm `provider_inconclusive` stays unresolved, provider not-found blocks success, provider match/inconclusive/ambiguity/conflict block unsafe not-applied, journal review requires duplicate-risk acknowledgment and performs no provider call, history shows the evidence classification, and stale/replayed confirmation is rejected. For create candidate not-applied, confirm the separate mutation-candidate warning and acknowledgment are required.
13. Remove the Preview ServiceNow URL/credential temporarily. Confirm command list/detail and confirmation still load, provider-unavailable manual success accepts only the prefilled read-only candidate pair, read-back records a bounded unavailable result, and Execute/Retry stay blocked. Restore the values and redeploy.
14. Let a readiness proof expire or change `SERVICENOW_CREDENTIAL_VERSION`. Confirm execute/retry are blocked, no attempt is consumed, run **Test readiness**, and confirm live readiness returns. Also verify a future browser timestamp cannot extend proof or confirmation lifetime.
15. Leave one disposable Attempt in `executing`. Confirm its start and recovery-eligible timestamps are visible, recovery is unavailable before eligibility, a direct early request is rejected, and no confirmation is issued early. At eligibility, refresh and recover it; confirm the recovery action makes no provider request, the original outcome is shown as unknown, the command enters `reconciliation_required`, and recovery history is immutable.
16. Deliver a simulated late success after recovery. Confirm bounded `SERVICENOW_WRITE_ATTEMPT_ALREADY_RECOVERED`, a sanitized late-response log, and no change to the command, Attempt, candidate history, or Ticket links.
17. For G2, verify a valid exact-marker GET pair succeeds; missing exact proof, missing identity, mismatched `sys_id`, mismatched number, and forged request target all fail. For update, comment, and work note, verify the original target cannot change while a missing counterpart can be added safely.
18. Resolve candidate A, append later inconclusive display history, then create candidate B after the allowed retry. Confirm A remains terminal, B alone is current, and confirmation submits B's event ID.
19. Disable live writes and redeploy after acceptance.

Never use production identifiers or paste credentials, provider bodies, or customer narratives into acceptance evidence.
