import type { JsonObject } from "@/lib/integrations";

export const intakeChannelProviders = ["email", "line", "web", "internal"] as const;
export const intakeEventTypes = ["message.received", "message.updated", "conversation.started"] as const;
export const messageDirections = ["inbound", "outbound", "internal"] as const;
export const messageTypes = ["text", "html", "image", "file", "video", "audio", "location", "sticker", "structured", "system"] as const;
export const messageStatuses = ["received", "validated", "stored", "rejected", "failed"] as const;
export const conversationStatuses = ["open", "awaiting_customer", "awaiting_agent", "linked", "closed", "archived"] as const;
export const sessionStatuses = ["draft", "collecting", "awaiting_confirmation", "confirmed", "cancelled", "expired", "failed"] as const;
export const attachmentStatuses = ["declared", "pending_download", "stored", "quarantined", "rejected", "failed", "deleted"] as const;
export const attachmentScanStatuses = ["not_scanned", "pending", "clean", "suspicious", "infected", "failed"] as const;
export const outboxCommandTypes = ["message.reply", "message.push", "ticket.create", "ticket.update", "attachment.upload", "notification.send"] as const;
export const outboxStatuses = ["pending", "processing", "retrying", "succeeded", "dead_letter", "cancelled"] as const;

export type IntakeChannelProvider = (typeof intakeChannelProviders)[number];
export type IntakeEventType = (typeof intakeEventTypes)[number];
export type MessageDirection = (typeof messageDirections)[number];
export type MessageType = (typeof messageTypes)[number];
export type MessageStatus = (typeof messageStatuses)[number];
export type ConversationStatus = (typeof conversationStatuses)[number];
export type IntakeSessionStatus = (typeof sessionStatuses)[number];
export type AttachmentStatus = (typeof attachmentStatuses)[number];
export type AttachmentScanStatus = (typeof attachmentScanStatuses)[number];
export type OutboxCommandType = (typeof outboxCommandTypes)[number];
export type OutboxStatus = (typeof outboxStatuses)[number];

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };
export type ChannelId = Brand<string, "ChannelId">;
export type ExternalIdentityId = Brand<string, "ExternalIdentityId">;
export type BindingId = Brand<string, "BindingId">;
export type ConversationId = Brand<string, "ConversationId">;
export type MessageId = Brand<string, "MessageId">;
export type AttachmentId = Brand<string, "AttachmentId">;
export type SessionId = Brand<string, "SessionId">;
export type IntakeEventId = Brand<string, "IntakeEventId">;
export type OutboxCommandId = Brand<string, "OutboxCommandId">;
export type ExternalEventId = Brand<string, "ExternalEventId">;
export type ExternalSubjectId = Brand<string, "ExternalSubjectId">;
export type ExternalConversationId = Brand<string, "ExternalConversationId">;
export type ExternalMessageId = Brand<string, "IntakeExternalMessageId">;
export type IntakeIdempotencyKey = Brand<string, "IntakeIdempotencyKey">;
export type CorrelationId = Brand<string, "IntakeCorrelationId">;

export interface IntakeObjectStorageContract {
  declareMetadata(input: {
    attachmentId: AttachmentId;
    storageObjectKey: string;
    metadata: JsonObject;
  }): Promise<void>;
}
