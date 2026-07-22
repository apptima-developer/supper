# Intake Identity and Binding

External identities are unique within an integration channel. The exact `external_subject_id` is retained server-side because a future adapter will need it, while a SHA-256 hash supports deterministic masking. List and detail APIs expose a mask derived from the hash, never the complete provider identifier.

`support_apply_intake_identity_binding(jsonb)` resolves an internal identity and an active canonical `support_customers.customer_key`, validates the project code, and serializes changes with an advisory/row lock. It creates, changes, reactivates, or returns `unchanged`. Every real decision appends an immutable `integration_identity_binding_events` row. `support_revoke_intake_identity_binding(jsonb)` is non-destructive and repeated revoke is unchanged without a duplicate event.

Bindings never create customers or ServiceNow callers. `allowed_systems` and provider-neutral `target_references` are bounded, server-only administration data and are not returned by operations APIs. Invitation codes, LINE Login, self-service linking, and customer-managed binding belong to AI-2.1.
