# Intake Outbox

`integration_outbox` records durable outbound command intent so later provider writes do not depend on an unreliable cross-system browser transaction. Supported bounded command types are message reply/push, ticket create/update, attachment upload, and notification send.

`support_enqueue_integration_outbox(jsonb)` starts new commands as `pending` with zero attempts. Reusing an idempotency key with identical normalized material returns `unchanged`; changed material returns `INTEGRATION_OUTBOX_IDEMPOTENCY_CONFLICT`. Payloads are bounded and reject credential-like keys.

AI-1.3 intentionally has no worker, lease/claim API, scheduler, retry timer, sender, manual execution button, or network operation. The protected Outbox page is read-only and states this limitation. Processing semantics, observability, retention, and dead-letter recovery require a later reviewed milestone.
