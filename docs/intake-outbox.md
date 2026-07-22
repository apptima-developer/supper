# Intake Outbox

`integration_outbox` records durable outbound command intent so later provider writes do not depend on an unreliable cross-system browser transaction. Supported bounded command types are message reply/push, ticket create/update, attachment upload, and notification send.

`support_enqueue_integration_outbox_v2(jsonb)` starts new commands as `pending` with zero attempts. Reusing an idempotency key with identical normalized material returns `unchanged` with the command's real bounded status and attempt count; it never resets or requeues a `processing`, `retrying`, `succeeded`, `dead_letter`, or `cancelled` command. Changed material returns `INTEGRATION_OUTBOX_IDEMPOTENCY_CONFLICT`.

Payloads are bounded and recursively reject normalized and compact credential-like keys at every depth. Canonical/idempotency payload numbers must be safe integers; fractions and unsafe integers return `INTAKE_CANONICAL_NUMBER_INVALID`. Outbox metadata accepts only `source` and `diagnostic`. Provider filters accept every integration target provider (`email`, `n8n`, `servicenow`, `internal`, `line`, `web`, and `freshservice`), unlike ordinary intake-channel filters.

AI-1.3 intentionally has no worker, lease/claim API, scheduler, retry timer, sender, manual execution button, or network operation. The protected Outbox page is read-only and states this limitation. Processing semantics, observability, retention, and dead-letter recovery require a later reviewed milestone.
