# Intake Messages and Attachments

Messages belong to one channel and conversation and are idempotent by `(channel_id, external_message_id)`. Before persistence, the service computes canonical material from channel/conversation/message identities, sender, direction, type, reply target, bodies, structured content, provider time, and attachment summaries. SQL recomputes and compares it. An exact replay returns `duplicate_message` and reuses the persisted conversation and identity without creating a session; any changed canonical field returns `INTAKE_MESSAGE_REPLAY_MISMATCH` and rolls back the entire event.

Text and HTML are stored separately; HTML is opaque untrusted input and is never rendered or returned by Operations. Conversation lists contain SQL counts only. Authorized detail returns a paginated plain-text preview and lifecycle metadata, with deterministic ordering, a hard limit of 100, and an explicit `hasNext` value.

Attachments in AI-1.3 are metadata declarations only. The immutable provider-source identity contains the external attachment ID, filename, MIME type, declared size, optional content hash, provider locator, and allowlisted source metadata. Each row stores `source_material_hash`, and Message/Event canonical material sorts and hashes those immutable source hashes. Changing a source field under the same provider attachment identity returns `INTAKE_ATTACHMENT_REPLAY_MISMATCH` and rolls back.

SUPPER-owned lifecycle fields are deliberately separate: `storage_status`, `storage_object_key`, `scan_status`, and `retention_until` may change after declaration without changing provider, Message, or Event identity. A replay after a lifecycle-only update therefore remains an exact replay and preserves the updated lifecycle state. Lifecycle state must never be used to disguise a changed provider filename, type, size, hash, locator, external ID, or source metadata.

Validation rejects path traversal, local paths, Base64, invalid MIME, negative or oversized declarations. The server-only provider locator and opaque storage object key are excluded from browser responses. Attachment detail is independently paginated with a maximum of 100 and never selects either field.

Canonical JSON allows only safe integers from `-9007199254740991` through `9007199254740991`; declared sizes, metadata, structured content, target references, and idempotency material follow the same recursive rule. TypeScript and PostgreSQL consume the same committed canonical-vector fixture to prevent replay drift.

`IntakeObjectStorage` is an interface for a future reviewed adapter. No Supabase Storage or S3 client, upload, download, signed URL, byte persistence, malware scan, or local runtime-file fallback exists in this milestone.
