import { z } from "zod";
import { isValidRequestId } from "../request-id";
import {
  integrationErrorCategories,
  integrationEventTypes,
  integrationOperations,
  integrationProviders,
  type ExternalMessageId,
  type ExternalThreadId,
  type ExternalTicketId,
  type IntegrationCorrelationId,
  type IntegrationEventId,
  type IntegrationIdempotencyKey,
  type JsonObject,
  type JsonValue,
} from "./contracts";

export const integrationBoundaryLimits = Object.freeze({
  identifierCharacters: 200,
  subjectCharacters: 500,
  textBodyCharacters: 200_000,
  htmlBodyCharacters: 500_000,
  recipients: 100,
  attachments: 50,
  attachmentBytes: 1024 * 1024 * 1024,
  metadataDepth: 5,
  metadataKeys: 50,
  metadataArrayItems: 50,
  metadataStringCharacters: 1_000,
  metadataBytes: 16 * 1024,
  retryAttempts: 20,
} as const);

const controlCharacters = /[\u0000-\u001f\u007f]/;
const lineBreaks = /[\r\n]/;
const forbiddenObjectKeys = new Set(["__proto__", "constructor", "prototype"]);

function safeString(maximum: number, label: string) {
  return z.string()
    .trim()
    .min(1, `${label} is required`)
    .max(maximum, `${label} is too long`)
    .refine((value) => !controlCharacters.test(value), `${label} contains control characters`);
}

function identifierSchema<Name extends string>(name: Name) {
  return safeString(integrationBoundaryLimits.identifierCharacters, name);
}

export const integrationProviderSchema = z.enum(integrationProviders);
export const integrationOperationSchema = z.enum(integrationOperations);
export const integrationEventTypeSchema = z.enum(integrationEventTypes);
export const integrationErrorCategorySchema = z.enum(integrationErrorCategories);

export const externalMessageIdSchema = identifierSchema("externalMessageId")
  .transform((value) => value as ExternalMessageId);
export const externalThreadIdSchema = identifierSchema("externalThreadId")
  .transform((value) => value as ExternalThreadId);
export const externalTicketIdSchema = identifierSchema("externalTicketId")
  .transform((value) => value as ExternalTicketId);
export const integrationEventIdSchema = identifierSchema("eventId")
  .transform((value) => value as IntegrationEventId);
export const correlationIdSchema = z.string()
  .trim()
  .refine(isValidRequestId, "correlationId must follow the application request ID policy")
  .transform((value) => value as IntegrationCorrelationId);
export const idempotencyKeySchema = z.string()
  .regex(/^supper:v1:[a-f0-9]{64}$/, "idempotencyKey must use the supper:v1 SHA-256 format")
  .transform((value) => value as IntegrationIdempotencyKey);

function cloneJsonValue(input: unknown, depth: number): JsonValue {
  if (depth > integrationBoundaryLimits.metadataDepth) {
    throw new Error("Metadata exceeds the maximum depth");
  }
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error("Metadata numbers must be finite");
    return input;
  }
  if (typeof input === "string") {
    if (input.length > integrationBoundaryLimits.metadataStringCharacters) {
      throw new Error("Metadata string is too long");
    }
    if (controlCharacters.test(input)) throw new Error("Metadata string contains control characters");
    return input;
  }
  if (Array.isArray(input)) {
    if (input.length > integrationBoundaryLimits.metadataArrayItems) {
      throw new Error("Metadata array has too many items");
    }
    return input.map((value) => cloneJsonValue(value, depth + 1));
  }
  if (!input || typeof input !== "object") throw new Error("Metadata must be JSON-safe");

  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("Metadata must use plain objects");
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.some((key) => typeof key === "symbol")) throw new Error("Metadata cannot contain symbol keys");
  if (ownKeys.length > integrationBoundaryLimits.metadataKeys) throw new Error("Metadata object has too many keys");

  const output: JsonObject = {};
  for (const key of ownKeys as string[]) {
    if (forbiddenObjectKeys.has(key)) throw new Error("Metadata contains a forbidden object key");
    if (key.length > 100 || controlCharacters.test(key)) throw new Error("Metadata key is invalid");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || descriptor.get || descriptor.set) throw new Error("Metadata accessors are not supported");
    if (!descriptor.enumerable) continue;
    output[key] = cloneJsonValue(descriptor.value, depth + 1);
  }
  return output;
}

export function cloneBoundedJsonObject(input: unknown): JsonObject {
  const value = cloneJsonValue(input, 0);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Metadata must be an object");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > integrationBoundaryLimits.metadataBytes) {
    throw new Error("Metadata exceeds the maximum encoded size");
  }
  return value;
}

export const boundedMetadataSchema = z.unknown().transform((input, context) => {
  try {
    return cloneBoundedJsonObject(input);
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid metadata" });
    return z.NEVER;
  }
});

const emailAddressValueSchema = z.string()
  .trim()
  .max(320)
  .refine((value) => !controlCharacters.test(value), "Email address contains control characters")
  .pipe(z.email())
  .transform((value) => value.toLowerCase());

export const normalizedEmailAddressSchema = z.object({
  address: emailAddressValueSchema,
  displayName: z.string()
    .trim()
    .max(200)
    .refine((value) => !lineBreaks.test(value) && !controlCharacters.test(value), "Display name is invalid")
    .optional(),
}).strict();

const allowedHeaders = new Set([
  "content-language",
  "date",
  "in-reply-to",
  "message-id",
  "references",
  "reply-to",
  "x-correlation-id",
]);
const sensitiveHeaders = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
]);

export const normalizedHeaderMapSchema = z.record(z.string(), z.string()).transform((headers, context) => {
  const normalized: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = rawName.trim().toLowerCase();
    if (sensitiveHeaders.has(name)) {
      context.addIssue({ code: "custom", path: [rawName], message: "Sensitive headers are not accepted" });
      continue;
    }
    if (!allowedHeaders.has(name)) {
      context.addIssue({ code: "custom", path: [rawName], message: "Header is not allowlisted" });
      continue;
    }
    const value = rawValue.trim();
    if (!value || value.length > 998 || lineBreaks.test(value) || controlCharacters.test(value)) {
      context.addIssue({ code: "custom", path: [rawName], message: "Header value is invalid" });
      continue;
    }
    if (Object.hasOwn(normalized, name)) {
      context.addIssue({ code: "custom", path: [rawName], message: "Duplicate normalized header" });
      continue;
    }
    normalized[name] = value;
  }
  return normalized;
});

export const attachmentMetadataSchema = z.object({
  externalAttachmentId: identifierSchema("externalAttachmentId"),
  filename: z.string()
    .trim()
    .min(1)
    .max(255)
    .refine((value) => !controlCharacters.test(value) && !/[\\/]/.test(value), "filename is invalid"),
  contentType: z.string().trim().min(1).max(127).regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i),
  sizeBytes: z.number().int().nonnegative().max(integrationBoundaryLimits.attachmentBytes),
  disposition: z.enum(["attachment", "inline"]).default("attachment"),
  contentId: safeString(255, "contentId").optional(),
  checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
}).strict();

const isoDateTimeInputSchema = z.union([z.string(), z.date()]).transform((input, context) => {
  if (typeof input === "string" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input)) {
    context.addIssue({ code: "custom", message: "Date must be an ISO-8601 timestamp with timezone" });
    return z.NEVER;
  }
  const date = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  if (!Number.isFinite(date.getTime())) {
    context.addIssue({ code: "custom", message: "Date is invalid" });
    return z.NEVER;
  }
  return date.toISOString();
});

export const normalizedMessageEnvelopeSchema = z.object({
  schemaVersion: z.literal("1.0"),
  provider: integrationProviderSchema,
  operation: integrationOperationSchema,
  externalMessageId: externalMessageIdSchema,
  externalThreadId: externalThreadIdSchema.optional(),
  correlationId: correlationIdSchema,
  idempotencyKey: idempotencyKeySchema,
  direction: z.enum(["inbound", "outbound"]),
  sender: normalizedEmailAddressSchema,
  recipients: z.array(normalizedEmailAddressSchema).min(1).max(integrationBoundaryLimits.recipients),
  ccRecipients: z.array(normalizedEmailAddressSchema).max(integrationBoundaryLimits.recipients).default([]),
  bccRecipients: z.array(normalizedEmailAddressSchema).max(integrationBoundaryLimits.recipients).default([]),
  replyTo: normalizedEmailAddressSchema.optional(),
  subject: z.string()
    .trim()
    .max(integrationBoundaryLimits.subjectCharacters)
    .refine((value) => !lineBreaks.test(value) && !controlCharacters.test(value), "Subject is invalid")
    .optional(),
  textBody: z.string().max(integrationBoundaryLimits.textBodyCharacters).optional(),
  htmlBody: z.string().max(integrationBoundaryLimits.htmlBodyCharacters).optional(),
  headers: normalizedHeaderMapSchema.default({}),
  attachments: z.array(attachmentMetadataSchema).max(integrationBoundaryLimits.attachments).default([]),
  sentAt: isoDateTimeInputSchema.optional(),
  receivedAt: isoDateTimeInputSchema,
  rawReference: safeString(500, "rawReference").optional(),
  metadata: boundedMetadataSchema.default({}),
}).strict();

function isLocalhost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function createExternalTicketReferenceSchema({ allowLocalhostHttp = false } = {}) {
  return z.object({
    provider: integrationProviderSchema,
    externalTicketId: externalTicketIdSchema,
    externalTicketNumber: identifierSchema("externalTicketNumber").optional(),
    externalUrl: z.string().trim().max(2_048).url().superRefine((value, context) => {
      const parsed = new URL(value);
      if (parsed.username || parsed.password) {
        context.addIssue({ code: "custom", message: "Ticket URL cannot contain credentials" });
      }
      const allowedLocal = allowLocalhostHttp && parsed.protocol === "http:" && isLocalhost(parsed.hostname);
      if (parsed.protocol !== "https:" && !allowedLocal) {
        context.addIssue({ code: "custom", message: "Ticket URL must use HTTPS" });
      }
    }).optional(),
    lastKnownState: safeString(100, "lastKnownState").optional(),
    lastSyncedAt: isoDateTimeInputSchema.optional(),
    correlationId: correlationIdSchema,
    metadata: boundedMetadataSchema.default({}),
  }).strict();
}

export const externalTicketReferenceSchema = createExternalTicketReferenceSchema();

export const retryMetadataSchema = z.object({
  attempt: z.number().int().min(1).max(integrationBoundaryLimits.retryAttempts),
  maxAttempts: z.number().int().min(1).max(integrationBoundaryLimits.retryAttempts),
  firstAttemptAt: isoDateTimeInputSchema,
  lastAttemptAt: isoDateTimeInputSchema,
  nextAttemptAt: isoDateTimeInputSchema.optional(),
  retryable: z.boolean(),
  reasonCode: z.string().trim().min(1).max(80).regex(/^[A-Z0-9_]+$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.attempt > value.maxAttempts) {
    context.addIssue({ code: "custom", path: ["attempt"], message: "attempt cannot exceed maxAttempts" });
  }
  if (value.lastAttemptAt < value.firstAttemptAt) {
    context.addIssue({ code: "custom", path: ["lastAttemptAt"], message: "lastAttemptAt cannot precede firstAttemptAt" });
  }
  if (value.nextAttemptAt && value.nextAttemptAt < value.lastAttemptAt) {
    context.addIssue({ code: "custom", path: ["nextAttemptAt"], message: "nextAttemptAt cannot precede lastAttemptAt" });
  }
});

export const integrationFailureSchema = z.object({
  category: integrationErrorCategorySchema,
  code: z.string().trim().min(1).max(80).regex(/^[A-Z0-9_]+$/),
  safeMessage: z.string().trim().min(1).max(240).refine((value) => !controlCharacters.test(value)),
  retryable: z.boolean(),
  provider: integrationProviderSchema,
  operation: integrationOperationSchema,
  correlationId: correlationIdSchema,
}).strict();

const eventBase = {
  schemaVersion: z.literal("1.0"),
  eventId: integrationEventIdSchema,
  provider: integrationProviderSchema,
  operation: integrationOperationSchema,
  correlationId: correlationIdSchema,
  causationId: integrationEventIdSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
  attempt: z.number().int().min(1).max(integrationBoundaryLimits.retryAttempts),
  occurredAt: isoDateTimeInputSchema,
  metadata: boundedMetadataSchema.default({}),
};

export const integrationEventSchema = z.discriminatedUnion("eventType", [
  z.object({
    ...eventBase,
    eventType: z.literal("message.received"),
    payload: z.object({
      externalMessageId: externalMessageIdSchema,
      rawReference: safeString(500, "rawReference").optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...eventBase,
    eventType: z.literal("message.normalized"),
    payload: z.object({ message: normalizedMessageEnvelopeSchema }).strict(),
  }).strict(),
  z.object({
    ...eventBase,
    eventType: z.literal("ticket.link.requested"),
    payload: z.object({
      externalMessageId: externalMessageIdSchema,
      ticket: externalTicketReferenceSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...eventBase,
    eventType: z.literal("ticket.linked"),
    payload: z.object({
      externalMessageId: externalMessageIdSchema,
      ticket: externalTicketReferenceSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...eventBase,
    eventType: z.literal("integration.failed"),
    payload: z.object({ error: integrationFailureSchema }).strict(),
  }).strict(),
]);

export type NormalizedEmailAddress = z.infer<typeof normalizedEmailAddressSchema>;
export type AttachmentMetadata = z.infer<typeof attachmentMetadataSchema>;
export type NormalizedMessageEnvelope = z.infer<typeof normalizedMessageEnvelopeSchema>;
export type ExternalTicketReference = z.infer<typeof externalTicketReferenceSchema>;
export type RetryMetadata = z.infer<typeof retryMetadataSchema>;
export type IntegrationEvent = z.infer<typeof integrationEventSchema>;
export type IntegrationEventCreationInput = IntegrationEvent extends infer Event
  ? Event extends IntegrationEvent
    ? Omit<Event, "schemaVersion" | "eventId" | "occurredAt">
    : never
  : never;
