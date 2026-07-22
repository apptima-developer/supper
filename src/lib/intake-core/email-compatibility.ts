import { createHash } from "node:crypto";
import type { EmailIntakeRecord } from "@/lib/email-intake/schemas";
import { acceptInboundEventSchema, type AcceptInboundEvent } from "./schemas";
import { hashExternalIdentity } from "./identity";

function id(prefix: string, material: string) {
  return `${prefix}-${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

export function mapEmailIntakeToUnifiedCommand(record: EmailIntakeRecord, channel: { id: string; channelKey: string }): AcceptInboundEvent {
  const material = `${record.provider}:${record.externalMessageId}`;
  const conversationExternalId = record.externalThreadId || record.externalMessageId;
  const bodyText = record.normalizedText || "";
  const bodyHtml = record.normalizedHtml || "";
  const contentHash = createHash("sha256").update(JSON.stringify({ bodyText, bodyHtml })).digest("hex");
  return acceptInboundEventSchema.parse({
    channel: { id: channel.id, provider: "email", channelKey: channel.channelKey },
    event: {
      id: id("evt", material), externalEventId: `email-intake:${record.intakeId}`,
      eventType: "message.received", payloadHash: createHash("sha256").update(record.idempotencyKey).digest("hex"),
      correlationId: record.correlationId, receivedAt: record.receivedAt, metadata: { compatibilitySource: "email-intake-v1" },
    },
    identity: {
      id: id("identity", record.sender.address), externalSubjectId: record.sender.address,
      externalSubjectHash: hashExternalIdentity(record.sender.address), displayName: record.sender.displayName || "",
      identityType: "contact", metadata: {},
    },
    conversation: {
      id: id("conversation", `${channel.id}:${conversationExternalId}`), externalConversationId: conversationExternalId,
      subject: record.subject || "", openedAt: record.receivedAt, lastActivityAt: record.receivedAt, metadata: {},
    },
    message: {
      id: id("message", material), externalMessageId: record.externalMessageId, direction: record.direction,
      messageType: bodyHtml && !bodyText ? "html" : "text", status: "stored", bodyText, bodyHtml,
      structuredContent: {}, contentHash, receivedAt: record.receivedAt, storedAt: record.createdAt, metadata: {},
    },
    attachments: record.attachmentSummary.map((attachment, index) => ({
      id: id("attachment", `${material}:${index}:${attachment.filename}`),
      externalAttachmentId: attachment.externalAttachmentId,
      fileName: attachment.filename, contentType: attachment.contentType, declaredSize: attachment.sizeBytes,
      sha256: attachment.checksum?.replace(/^sha256:/, ""), metadata: {},
    })),
  });
}
