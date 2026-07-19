import { deriveMessageIdempotencyKey } from "../integrations/idempotency";
import { correlationIdSchema, externalMessageIdSchema } from "../integrations/schemas";
import { EmailIntakeAggregate } from "./aggregate";

export const correlationId = correlationIdSchema.parse("request-email-intake-1234");

export function envelope(externalId = "message-42", overrides: Record<string, unknown> = {}) {
  const externalMessageId = externalMessageIdSchema.parse(externalId);
  return {
    schemaVersion: "1.0",
    provider: "email",
    operation: "message.normalize",
    externalMessageId,
    correlationId,
    idempotencyKey: deriveMessageIdempotencyKey({ provider: "email", operation: "message.receive", externalMessageId }),
    direction: "inbound",
    sender: { address: " Agent@Example.COM ", displayName: "Agent One" },
    recipients: [{ address: "support@example.com" }],
    ccRecipients: [{ address: "lead@example.com" }],
    replyTo: { address: "reply@example.com" },
    subject: "Support request",
    textBody: "Normalized message text",
    htmlBody: "<p>Normalized message HTML</p>",
    headers: { "Message-ID": `<${externalId}@example.com>` },
    attachments: [{
      externalAttachmentId: "attachment-1",
      filename: "evidence.png",
      contentType: "image/png",
      sizeBytes: 1_024,
    }],
    receivedAt: "2026-07-18T03:20:30.000Z",
    metadata: { mailbox: "support" },
    ...overrides,
  };
}

export function dependencies(intakeId = "intake-1", at = "2026-07-18T03:21:00.000Z") {
  let number = 0;
  return {
    now: () => new Date(at),
    createIntakeId: () => intakeId,
    createAuditId: () => `audit-${++number}`,
    createEventId: () => `event-${++number}`,
  };
}

export function context(iso: string, actor = "support-agent") {
  let number = 0;
  return {
    correlationId,
    actor,
    at: new Date(iso),
    createAuditId: () => `audit-action-${iso}-${++number}`,
    createEventId: () => `event-action-${iso}-${++number}`,
  };
}

export function createAggregate(externalId = "message-42") {
  return EmailIntakeAggregate.create(envelope(externalId), "system", dependencies(`intake-${externalId}`)).aggregate;
}
