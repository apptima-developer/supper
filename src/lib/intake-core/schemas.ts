import { z } from "zod";
import { boundedMetadataSchema, integrationBoundaryLimits } from "@/lib/integrations";
import { containsControlCharacters } from "@/lib/integrations/validation";
import { isValidRequestId } from "@/lib/request-id";
import {
  attachmentScanStatuses, attachmentStatuses, intakeChannelProviders,
  intakeEventTypes, messageDirections, messageStatuses, messageTypes, outboxCommandTypes,
  sessionStatuses,
} from "./contracts";

export const intakeLimits = Object.freeze({
  identifierCharacters: 200, displayNameCharacters: 200, channelKeyCharacters: 120,
  subjectCharacters: 500, textBodyCharacters: integrationBoundaryLimits.textBodyCharacters,
  htmlBodyCharacters: integrationBoundaryLimits.htmlBodyCharacters, attachmentsPerEvent: 50,
  attachmentBytes: 250 * 1024 * 1024, fileNameCharacters: 255, contentTypeCharacters: 150,
  stateBytes: 32 * 1024, outboxPayloadBytes: 64 * 1024, listLimit: 100,
} as const);

function wellFormedUnicode(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function intakeIdentifierSchema(label: string, max: number = intakeLimits.identifierCharacters) {
  return z.string().trim().min(1, `${label} is required`).max(max, `${label} is too long`)
    .refine((value) => !containsControlCharacters(value), `${label} contains control characters`)
    .refine(wellFormedUnicode, `${label} contains malformed Unicode`);
}

export const canonicalTimestampSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "Timestamp must use canonical UTC milliseconds")
  .refine((value) => !Number.isNaN(Date.parse(value)), "Timestamp is invalid");
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const channelIdSchema = intakeIdentifierSchema("channelId");
export const identityIdSchema = intakeIdentifierSchema("identityId");
export const bindingIdSchema = intakeIdentifierSchema("bindingId");
export const conversationIdSchema = intakeIdentifierSchema("conversationId");
export const messageIdSchema = intakeIdentifierSchema("messageId");
export const attachmentIdSchema = intakeIdentifierSchema("attachmentId");
export const sessionIdSchema = intakeIdentifierSchema("sessionId");
export const eventIdSchema = intakeIdentifierSchema("eventId");
export const outboxIdSchema = intakeIdentifierSchema("outboxCommandId");
export const externalSubjectIdSchema = intakeIdentifierSchema("externalSubjectId", 500);
export const externalConversationIdSchema = intakeIdentifierSchema("externalConversationId", 500);
export const externalMessageIdSchema = intakeIdentifierSchema("externalMessageId", 500);
export const externalEventIdSchema = intakeIdentifierSchema("externalEventId", 500);
export const correlationIdSchema = z.string().trim().refine(isValidRequestId, "Invalid correlation ID");
export const intakeChannelProviderSchema = z.enum(intakeChannelProviders);

const secretKey = /^(authorization|cookie|password|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|signed[_-]?url)$/i;
function containsSecretKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSecretKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => secretKey.test(key) || containsSecretKey(child));
}

function encodedBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function boundedJson(maxBytes: number, rejectSecrets = false) {
  return boundedMetadataSchema.superRefine((value, context) => {
    if (encodedBytes(value) > maxBytes) context.addIssue({ code: "custom", message: "JSON value is too large" });
    if (rejectSecrets && containsSecretKey(value)) context.addIssue({ code: "custom", message: "Credentials are not accepted" });
  });
}

export const safeStateSchema = boundedJson(intakeLimits.stateBytes);
export const safeOutboxPayloadSchema = boundedJson(intakeLimits.outboxPayloadBytes, true);
const metadata = boundedJson(16 * 1024, true).default({});
const safeOptionalText = (max: number) => z.string().max(max).refine(wellFormedUnicode).optional();
const safeRequiredText = (max: number) => z.string().max(max).refine(wellFormedUnicode);

export const attachmentInputSchema = z.object({
  id: attachmentIdSchema, externalAttachmentId: intakeIdentifierSchema("externalAttachmentId", 500).optional(),
  fileName: intakeIdentifierSchema("fileName", intakeLimits.fileNameCharacters)
    .refine((value) => !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..", "Attachment filename contains path traversal"),
  contentType: z.string().trim().min(1).max(intakeLimits.contentTypeCharacters).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i),
  declaredSize: z.number().int().min(0).max(intakeLimits.attachmentBytes), sha256: sha256Schema.optional(),
  providerLocator: intakeIdentifierSchema("providerLocator", 1_000)
    .refine((value) => !/^(?:https?|file):\/\//i.test(value), "Provider locator must be an opaque server reference").optional(),
  storageStatus: z.enum(attachmentStatuses).default("declared"),
  scanStatus: z.enum(attachmentScanStatuses).default("not_scanned"),
  retentionUntil: canonicalTimestampSchema.optional(), metadata,
}).strict().superRefine((value, context) => {
  const serialized = JSON.stringify(value);
  if (/base64|data:[^,]+;base64|file:\/\/|\/var\/|\/tmp\//i.test(serialized)) {
    context.addIssue({ code: "custom", message: "Attachment bytes, Base64, and local paths are not accepted" });
  }
});

export const sessionStateSchema = z.object({
  selectedCustomerKey: safeOptionalText(600), projectCode: safeOptionalText(200), systemKey: safeOptionalText(200),
  requestType: safeOptionalText(100), description: safeOptionalText(20_000), impact: safeOptionalText(100),
  urgency: safeOptionalText(100), attachmentIds: z.array(attachmentIdSchema).max(50).optional(), summary: safeOptionalText(2_000),
}).strict();

export const acceptInboundEventSchema = z.object({
  channel: z.object({ id: channelIdSchema, provider: intakeChannelProviderSchema, channelKey: intakeIdentifierSchema("channelKey", intakeLimits.channelKeyCharacters) }).strict(),
  event: z.object({ id: eventIdSchema, externalEventId: externalEventIdSchema, eventType: z.enum(intakeEventTypes), payloadHash: sha256Schema, correlationId: correlationIdSchema, requestId: correlationIdSchema.optional(), receivedAt: canonicalTimestampSchema, metadata }).strict(),
  identity: z.object({ id: identityIdSchema, externalSubjectId: externalSubjectIdSchema, externalSubjectHash: sha256Schema, displayName: safeRequiredText(intakeLimits.displayNameCharacters).default(""), identityType: z.enum(["user", "contact", "mailbox", "system", "anonymous"]), metadata }).strict(),
  conversation: z.object({ id: conversationIdSchema, externalConversationId: externalConversationIdSchema, subject: safeRequiredText(intakeLimits.subjectCharacters).default(""), openedAt: canonicalTimestampSchema, lastActivityAt: canonicalTimestampSchema, metadata }).strict(),
  message: z.object({ id: messageIdSchema, externalMessageId: externalMessageIdSchema, replyToMessageId: messageIdSchema.optional(), direction: z.enum(messageDirections), messageType: z.enum(messageTypes), status: z.enum(messageStatuses), bodyText: safeRequiredText(intakeLimits.textBodyCharacters).default(""), bodyHtml: safeRequiredText(intakeLimits.htmlBodyCharacters).default(""), structuredContent: boundedJson(intakeLimits.stateBytes).default({}), contentHash: sha256Schema, providerSentAt: canonicalTimestampSchema.optional(), receivedAt: canonicalTimestampSchema, storedAt: canonicalTimestampSchema.optional(), metadata }).strict(),
  attachments: z.array(attachmentInputSchema).max(intakeLimits.attachmentsPerEvent).default([]),
  initializeSession: z.object({ id: sessionIdSchema, status: z.enum(["draft", "collecting"]), stateData: sessionStateSchema.default({}), missingFields: z.array(intakeIdentifierSchema("missingField", 100)).max(50).default([]), startedAt: canonicalTimestampSchema, expiresAt: canonicalTimestampSchema.optional() }).strict().optional(),
}).strict();

export const acceptInboundEventResultSchema = z.object({ action: z.enum(["accepted", "duplicate", "duplicate_message"]), event_id: z.string(), identity_id: z.string(), conversation_id: z.string(), message_id: z.string(), attachment_count: z.number().int().nonnegative(), session_id: z.string().nullable(), delivery_count: z.number().int().positive() }).strict();

export const identityBindingInputSchema = z.object({ bindingId: bindingIdSchema, eventId: eventIdSchema, identityId: identityIdSchema, customerKey: intakeIdentifierSchema("customerKey", 600), projectCode: z.string().trim().max(200).default(""), allowedSystems: z.array(intakeIdentifierSchema("systemKey", 200)).max(50).default([]), targetReferences: boundedJson(intakeLimits.stateBytes, true).default({}), actorUserId: intakeIdentifierSchema("actorUserId"), requestId: correlationIdSchema.optional(), correlationId: correlationIdSchema, appliedAt: canonicalTimestampSchema, metadata }).strict();
export const revokeBindingInputSchema = z.object({ identityId: identityIdSchema, actorUserId: intakeIdentifierSchema("actorUserId"), eventId: eventIdSchema, requestId: correlationIdSchema.optional(), correlationId: correlationIdSchema, appliedAt: canonicalTimestampSchema, metadata }).strict();
export const identityBindingResultSchema = z.object({ action: z.enum(["created", "changed", "reactivated", "unchanged", "revoked"]), binding_id: z.string(), identity_id: z.string(), customer_key: z.string().nullable(), project_code: z.string(), active: z.boolean() }).strict();

export const sessionTransitionInputSchema = z.object({ sessionId: sessionIdSchema, expectedVersion: z.number().int().positive(), targetStatus: z.enum(sessionStatuses), statePatch: sessionStateSchema.default({}), missingFields: z.array(intakeIdentifierSchema("missingField", 100)).max(50).default([]), actorUserId: intakeIdentifierSchema("actorUserId"), requestId: correlationIdSchema.optional(), correlationId: correlationIdSchema, occurredAt: canonicalTimestampSchema }).strict();
export const sessionSummarySchema = z.object({ id: z.string(), conversation_id: z.string(), status: z.enum(sessionStatuses), version: z.number().int().positive(), state_data: safeStateSchema, missing_fields: z.array(z.string()), started_at: canonicalTimestampSchema, expires_at: canonicalTimestampSchema.nullable(), confirmed_at: canonicalTimestampSchema.nullable(), cancelled_at: canonicalTimestampSchema.nullable(), failed_at: canonicalTimestampSchema.nullable(), updated_at: canonicalTimestampSchema }).strict();

export const enqueueOutboxInputSchema = z.object({ id: outboxIdSchema, targetProvider: z.enum(["email", "n8n", "servicenow", "internal", "line", "web", "freshservice"]), commandType: z.enum(outboxCommandTypes), idempotencyKey: intakeIdentifierSchema("idempotencyKey", 300), channelId: channelIdSchema.optional(), conversationId: conversationIdSchema.optional(), messageId: messageIdSchema.optional(), ticketId: intakeIdentifierSchema("ticketId").optional(), payload: safeOutboxPayloadSchema, availableAt: canonicalTimestampSchema, maxAttempts: z.number().int().min(1).max(20).default(5), correlationId: correlationIdSchema, requestId: correlationIdSchema.optional(), metadata }).strict();
export const enqueueOutboxResultSchema = z.object({ action: z.enum(["created", "unchanged"]), command_id: z.string(), status: z.literal("pending"), attempt_count: z.literal(0) }).strict();

export const listQuerySchema = z.object({ page: z.coerce.number().int().min(1).max(100_000).default(1), limit: z.coerce.number().int().min(1).max(intakeLimits.listLimit).default(25), status: z.string().trim().max(80).optional(), provider: intakeChannelProviderSchema.optional() }).strict();

export type AcceptInboundEvent = z.infer<typeof acceptInboundEventSchema>;
export type AcceptInboundEventResult = z.infer<typeof acceptInboundEventResultSchema>;
export type IdentityBindingInput = z.infer<typeof identityBindingInputSchema>;
export type RevokeBindingInput = z.infer<typeof revokeBindingInputSchema>;
export type SessionTransitionInput = z.infer<typeof sessionTransitionInputSchema>;
export type EnqueueOutboxInput = z.infer<typeof enqueueOutboxInputSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
