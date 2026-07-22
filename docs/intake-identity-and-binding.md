# Intake Identity and Binding

External identities are unique within an integration channel. The exact `external_subject_id` is retained server-side because a future adapter will need it, while a SHA-256 hash supports deterministic masking. List and detail APIs expose a mask derived from the hash, never the complete provider identifier.

The server derives the hash from the normalized external subject and SQL verifies it during acceptance. A caller-supplied mismatch returns `INTAKE_IDENTITY_HASH_MISMATCH`. Exact message replay resolves and reuses the persisted sender before any new identity or conversation is created, preventing one external message from being rebound to a different sender.

`support_apply_intake_identity_binding(jsonb)` resolves an internal identity and an active canonical `support_customers.customer_key`, validates the project code, and serializes changes with an advisory/row lock. It creates, changes, reactivates, or returns `unchanged`. Every real decision appends an immutable `integration_identity_binding_events` row. `support_revoke_intake_identity_binding(jsonb)` is non-destructive and repeated revoke is unchanged without a duplicate event.

Bindings never create customers or ServiceNow callers. `allowed_systems` and provider-neutral `target_references` are bounded, server-only administration data and are not returned by operations APIs. Target-reference keys are restricted to known integration providers and their nested JSON is recursively checked for credential-like keys. Binding metadata accepts only `source` and `reason`; unknown keys and raw provider records are rejected.

Identity lists are produced by a bounded service-role read RPC. Conversation counts are calculated in SQL rather than loading child rows. Provider filters on this page remain limited to ordinary intake channels (`email`, `line`, `web`, and `internal`). Invitation codes, LINE Login, self-service linking, and customer-managed binding belong to AI-2.1.
