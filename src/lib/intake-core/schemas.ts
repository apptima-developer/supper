import { z } from "zod";
import { boundedMetadataSchema, integrationBoundaryLimits, integrationProviderSchema } from "@/lib/integrations";
import { containsControlCharacters } from "@/lib/integrations/validation";
import { isValidRequestId } from "@/lib/request-id";
import {
  attachmentScanStatuses, attachmentStatuses, conversationStatuses, intakeChannelProviders,
  intakeEventTypes, messageDirections, messageStatuses, messageTypes, outboxCommandTypes,
  outboxStatuses, sessionStatuses,
} from "./contracts";
import { assertNoSensitiveIntakeData } from "./sensitive-data";

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

function encodedBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function boundedJson(maxBytes: number, rejectUnsafeKeys = true) {
  return boundedMetadataSchema.superRefine((value, context) => {
    if (encodedBytes(value) > maxBytes) context.addIssue({ code: "custom", message: "JSON value is too large" });
    if (rejectUnsafeKeys) {
      try { assertNoSensitiveIntakeData(value); }
      catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Unsafe JSON key" }); }
    }
  });
}

const metadataText = z.string().trim().max(500).refine(wellFormedUnicode);
function strictMetadata<T extends z.ZodRawShape>(shape: T) {
  return z.unknown().superRefine((value, context) => {
    try { assertNoSensitiveIntakeData(value); }
    catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Unsafe metadata" }); }
    if (encodedBytes(value) > 16 * 1024) context.addIssue({ code: "custom", message: "Metadata is too large" });
  }).pipe(z.object(shape).strict());
}

export const channelMetadataSchema = strictMetadata({ diagnostic: z.boolean().optional(), source: metadataText.optional() }).default({});
export const eventMetadataSchema = strictMetadata({
  diagnostic: z.boolean().optional(), source: metadataText.optional(), compatibilitySource: metadataText.optional(), adapterVersion: metadataText.optional(),
}).default({});
export const identityMetadataSchema = strictMetadata({ diagnostic: z.boolean().optional(), source: metadataText.optional() }).default({});
export const conversationMetadataSchema = strictMetadata({ diagnostic: z.boolean().optional(), source: metadataText.optional() }).default({});
export const messageMetadataSchema = strictMetadata({ diagnostic: z.boolean().optional(), source: metadataText.optional() }).default({});
export const attachmentMetadataSchema = strictMetadata({
  diagnostic: z.boolean().optional(), source: metadataText.optional(), disposition: z.enum(["attachment", "inline"]).optional(), ordinal: z.number().int().min(0).max(49).optional(),
}).default({});
export const sessionMetadataSchema = strictMetadata({ diagnostic: z.boolean().optional(), source: metadataText.optional() }).default({});
export const bindingMetadataSchema = strictMetadata({ source: metadataText.optional(), reason: metadataText.optional() }).default({});
export const outboxMetadataSchema = strictMetadata({ source: metadataText.optional(), diagnostic: z.boolean().optional() }).default({});

export const safeStateSchema = boundedJson(intakeLimits.stateBytes);
export const safeOutboxPayloadSchema = boundedJson(intakeLimits.outboxPayloadBytes);
export const structuredContentSchema = boundedJson(intakeLimits.stateBytes).default({});
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
  retentionUntil: canonicalTimestampSchema.optional(), metadata: attachmentMetadataSchema,
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

const acceptInboundEventBase = z.object({
  channel: z.object({ id: channelIdSchema, provider: intakeChannelProviderSchema, channelKey: intakeIdentifierSchema("channelKey", intakeLimits.channelKeyCharacters) }).strict(),
  event: z.object({ id: eventIdSchema, externalEventId: externalEventIdSchema, eventType: z.enum(intakeEventTypes), payloadHash: sha256Schema.optional(), correlationId: correlationIdSchema, requestId: correlationIdSchema.optional(), receivedAt: canonicalTimestampSchema, metadata: eventMetadataSchema }).strict(),
  identity: z.object({ id: identityIdSchema, externalSubjectId: externalSubjectIdSchema, externalSubjectHash: sha256Schema.optional(), displayName: safeRequiredText(intakeLimits.displayNameCharacters).default(""), identityType: z.enum(["user", "contact", "mailbox", "system", "anonymous"]), metadata: identityMetadataSchema }).strict(),
  conversation: z.object({ id: conversationIdSchema, externalConversationId: externalConversationIdSchema, subject: safeRequiredText(intakeLimits.subjectCharacters).default(""), openedAt: canonicalTimestampSchema, lastActivityAt: canonicalTimestampSchema, metadata: conversationMetadataSchema }).strict(),
  message: z.object({ id: messageIdSchema, externalMessageId: externalMessageIdSchema, replyToMessageId: messageIdSchema.optional(), direction: z.enum(messageDirections), messageType: z.enum(messageTypes), status: z.enum(messageStatuses), bodyText: safeRequiredText(intakeLimits.textBodyCharacters).default(""), bodyHtml: safeRequiredText(intakeLimits.htmlBodyCharacters).default(""), structuredContent: structuredContentSchema, contentHash: sha256Schema.optional(), providerSentAt: canonicalTimestampSchema.optional(), receivedAt: canonicalTimestampSchema, storedAt: canonicalTimestampSchema.optional(), metadata: messageMetadataSchema }).strict(),
  attachments: z.array(attachmentInputSchema).max(intakeLimits.attachmentsPerEvent).default([]),
  initializeSession: z.object({ id: sessionIdSchema, status: z.enum(["draft", "collecting"]), stateData: sessionStateSchema.default({}), missingFields: z.array(intakeIdentifierSchema("missingField", 100)).max(50).default([]), startedAt: canonicalTimestampSchema, expiresAt: canonicalTimestampSchema.optional(), metadata: sessionMetadataSchema }).strict().optional(),
}).strict();

export const acceptInboundEventInputSchema = acceptInboundEventBase;
export const acceptInboundEventSchema = acceptInboundEventBase.transform((value, context) => {
  if (!value.event.payloadHash || !value.identity.externalSubjectHash || !value.message.contentHash) {
    context.addIssue({ code: "custom", message: "Canonical intake hashes are required for persistence" });
    return z.NEVER;
  }
  return {
    ...value,
    event: { ...value.event, payloadHash: value.event.payloadHash },
    identity: { ...value.identity, externalSubjectHash: value.identity.externalSubjectHash },
    message: { ...value.message, contentHash: value.message.contentHash },
  };
});

export const acceptInboundEventResultSchema = z.object({ action: z.enum(["accepted", "duplicate", "duplicate_message"]), event_id: z.string(), identity_id: z.string(), conversation_id: z.string(), message_id: z.string(), attachment_count: z.number().int().nonnegative(), session_id: z.string().nullable(), delivery_count: z.number().int().positive() }).strict();

const targetReferenceValue = intakeIdentifierSchema("targetReference", 1_000);
export const targetReferencesSchema = z.object({
  email: targetReferenceValue.optional(), n8n: targetReferenceValue.optional(), servicenow: targetReferenceValue.optional(), internal: targetReferenceValue.optional(), line: targetReferenceValue.optional(), web: targetReferenceValue.optional(), freshservice: targetReferenceValue.optional(),
}).strict().superRefine((value, context) => {
  try { assertNoSensitiveIntakeData(value); }
  catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Unsafe target reference" }); }
});

export const identityBindingInputSchema = z.object({ bindingId: bindingIdSchema, eventId: eventIdSchema, identityId: identityIdSchema, customerKey: intakeIdentifierSchema("customerKey", 600), projectCode: z.string().trim().max(200).default(""), allowedSystems: z.array(intakeIdentifierSchema("systemKey", 200)).max(50).default([]), targetReferences: targetReferencesSchema.default({}), actorUserId: intakeIdentifierSchema("actorUserId"), requestId: correlationIdSchema.optional(), correlationId: correlationIdSchema, appliedAt: canonicalTimestampSchema, metadata: bindingMetadataSchema }).strict();
export const revokeBindingInputSchema = z.object({ identityId: identityIdSchema, actorUserId: intakeIdentifierSchema("actorUserId"), eventId: eventIdSchema, requestId: correlationIdSchema.optional(), correlationId: correlationIdSchema, appliedAt: canonicalTimestampSchema, metadata: bindingMetadataSchema }).strict();
export const identityBindingResultSchema = z.object({ action: z.enum(["created", "changed", "reactivated", "unchanged", "revoked"]), binding_id: z.string(), identity_id: z.string(), customer_key: z.string().nullable(), project_code: z.string(), active: z.boolean() }).strict();

export const sessionTransitionInputSchema = z.object({ eventId: eventIdSchema, sessionId: sessionIdSchema, expectedVersion: z.number().int().positive(), targetStatus: z.enum(sessionStatuses), statePatch: sessionStateSchema.default({}), missingFields: z.array(intakeIdentifierSchema("missingField", 100)).max(50).default([]), actorUserId: intakeIdentifierSchema("actorUserId"), requestId: correlationIdSchema.optional(), correlationId: correlationIdSchema, occurredAt: canonicalTimestampSchema, metadata: sessionMetadataSchema }).strict();
export const sessionSummarySchema = z.object({ id: z.string(), conversation_id: z.string(), status: z.enum(sessionStatuses), version: z.number().int().positive(), state_data: sessionStateSchema, missing_fields: z.array(z.string()), started_at: canonicalTimestampSchema, expires_at: canonicalTimestampSchema.nullable(), confirmed_at: canonicalTimestampSchema.nullable(), cancelled_at: canonicalTimestampSchema.nullable(), failed_at: canonicalTimestampSchema.nullable(), updated_at: canonicalTimestampSchema }).strict();

export const conversationTransitionInputSchema = z.object({ eventId: eventIdSchema, conversationId: conversationIdSchema, expectedVersion: z.number().int().positive(), targetStatus: z.enum(conversationStatuses), explicitReopen: z.boolean().default(false), actorUserId: intakeIdentifierSchema("actorUserId"), requestId: correlationIdSchema.optional(), correlationId: correlationIdSchema, occurredAt: canonicalTimestampSchema, metadata: conversationMetadataSchema }).strict();
export const conversationSummarySchema = z.object({ id: z.string(), status: z.enum(conversationStatuses), version: z.number().int().positive(), last_activity_at: canonicalTimestampSchema, closed_at: canonicalTimestampSchema.nullable(), updated_at: canonicalTimestampSchema }).strict();

export const enqueueOutboxInputSchema = z.object({ id: outboxIdSchema, targetProvider: integrationProviderSchema, commandType: z.enum(outboxCommandTypes), idempotencyKey: intakeIdentifierSchema("idempotencyKey", 300), channelId: channelIdSchema.optional(), conversationId: conversationIdSchema.optional(), messageId: messageIdSchema.optional(), ticketId: intakeIdentifierSchema("ticketId").optional(), payload: safeOutboxPayloadSchema, availableAt: canonicalTimestampSchema, maxAttempts: z.number().int().min(1).max(20).default(5), correlationId: correlationIdSchema, requestId: correlationIdSchema.optional(), metadata: outboxMetadataSchema }).strict();
export const enqueueOutboxResultSchema = z.object({ action: z.enum(["created", "unchanged"]), command_id: z.string(), status: z.enum(outboxStatuses), attempt_count: z.number().int().min(0).max(20) }).strict();

const paginationShape = { page: z.coerce.number().int().min(1).max(100_000).default(1), limit: z.coerce.number().int().min(1).max(intakeLimits.listLimit).default(25) };
export const intakeChannelListQuerySchema = z.object({ ...paginationShape, status: z.enum(["unconfigured", "configured", "disabled", "error"]).optional(), provider: intakeChannelProviderSchema.optional() }).strict();
export const identityListQuerySchema = z.object({ ...paginationShape, status: z.enum(["unlinked", "pending", "linked", "revoked", "blocked"]).optional(), provider: intakeChannelProviderSchema.optional() }).strict();
export const conversationListQuerySchema = z.object({ ...paginationShape, status: z.enum(conversationStatuses).optional(), provider: intakeChannelProviderSchema.optional() }).strict();
export const eventListQuerySchema = z.object({ ...paginationShape, status: z.enum(["received", "accepted", "rejected", "failed"]).optional(), provider: intakeChannelProviderSchema.optional() }).strict();
export const outboxListQuerySchema = z.object({ ...paginationShape, status: z.enum(outboxStatuses).optional(), provider: integrationProviderSchema.optional() }).strict();
export const conversationMessageListQuerySchema = z.object(paginationShape).strict();
export const conversationAttachmentListQuerySchema = z.object(paginationShape).strict();
export const sessionListQuerySchema = z.object({ ...paginationShape, status: z.enum(sessionStatuses).optional() }).strict();

export type AcceptInboundEventInput = z.infer<typeof acceptInboundEventInputSchema>;
export type AcceptInboundEvent = z.infer<typeof acceptInboundEventSchema>;
export type AttachmentInput = z.infer<typeof attachmentInputSchema>;
export type AcceptInboundEventResult = z.infer<typeof acceptInboundEventResultSchema>;
export type IdentityBindingInput = z.infer<typeof identityBindingInputSchema>;
export type RevokeBindingInput = z.infer<typeof revokeBindingInputSchema>;
export type SessionTransitionInput = z.infer<typeof sessionTransitionInputSchema>;
export type ConversationTransitionInput = z.infer<typeof conversationTransitionInputSchema>;
export type EnqueueOutboxInput = z.infer<typeof enqueueOutboxInputSchema>;
export type ChannelListQuery = z.infer<typeof intakeChannelListQuerySchema>;
export type IdentityListQuery = z.infer<typeof identityListQuerySchema>;
export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;
export type EventListQuery = z.infer<typeof eventListQuerySchema>;
export type OutboxListQuery = z.infer<typeof outboxListQuerySchema>;
export type ChildListQuery = z.infer<typeof conversationMessageListQuerySchema>;
export type SessionListQuery = z.infer<typeof sessionListQuerySchema>;
