# Intake Messages and Attachments

Messages belong to one channel and conversation and are idempotent by `(channel_id, external_message_id)`. Text and HTML are stored separately; HTML is opaque untrusted input and is never rendered. Conversation lists contain counts only, while authorized detail returns a bounded plain-text preview and lifecycle metadata.

Attachments in AI-1.3 are metadata declarations only: bounded filename, MIME type, declared size, optional hash, storage/scan status, and retention placeholder. Validation rejects path traversal, local paths, Base64, invalid MIME, negative or oversized declarations. The server-only provider locator and opaque storage object key are excluded from browser responses.

`IntakeObjectStorage` is an interface for a future reviewed adapter. No Supabase Storage or S3 client, upload, download, signed URL, byte persistence, malware scan, or local runtime-file fallback exists in this milestone.
