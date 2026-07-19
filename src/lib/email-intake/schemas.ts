import { z } from "zod";
import {
  attachmentMetadataSchema,
  boundedMetadataSchema,
  correlationIdSchema,
  deriveMessageIdempotencyKey,
  externalMessageIdSchema,
  externalThreadIdSchema,
  idempotencyKeySchema,
  integrationBoundaryLimits,
  integrationProviderSchema,
  normalizedEmailAddressSchema,
} from "../integrations";

const controlCharacters = /[\u0000-\u001f\u007f]/;

function safeText(label: string, maximum: number) {
  return z.string()
    .trim()
    .min(1, `${label} is required`)
    .max(maximum, `${label} is too long`)
    .refine((value) => !controlCharacters.test(value), `${label} contains control characters`);
}

function isoTimestamp(label: string) {
  return z.string().superRefine((value, context) => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
      context.addIssue({ code: "custom", message: `${label} must be a normalized ISO timestamp` });
    }
  });
}

export const emailIntakeStatuses = [
  "RECEIVED",
  "VALIDATED",
  "QUEUED",
  "PROCESSING",
  "CLASSIFIED",
  "READY_FOR_TICKET",
  "COMPLETED",
  "FAILED",
  "REJECTED",
] as const;

export const emailIntakeStatusSchema = z.enum(emailIntakeStatuses);
export const emailIntakeIdSchema = safeText("intakeId", 200);
export const emailIntakeAuditIdSchema = safeText("auditId", 200);
export const emailIntakeEventIdSchema = safeText("eventId", 200);
export const emailIntakeActorSchema = safeText("actor", 200);
export const emailIntakeProcessorSchema = safeText("processor", 200);
export const emailIntakeReasonCodeSchema = z.string().trim().min(1).max(80).regex(/^[A-Z0-9_]+$/);
export const normalizedIsoTimestampSchema = isoTimestamp("timestamp");

const auditBase = {
  auditId: emailIntakeAuditIdSchema,
  occurredAt: normalizedIsoTimestampSchema,
  actor: emailIntakeActorSchema,
};

export const emailIntakeAuditEntrySchema = z.discriminatedUnion("action", [
  z.object({ ...auditBase, action: z.literal("created") }).strict(),
  z.object({ ...auditBase, action: z.literal("updated") }).strict(),
  z.object({
    ...auditBase,
    action: z.literal("status_changed"),
    previousStatus: emailIntakeStatusSchema,
    nextStatus: emailIntakeStatusSchema,
  }).strict(),
  z.object({
    ...auditBase,
    action: z.literal("processor_assigned"),
    processor: emailIntakeProcessorSchema,
  }).strict(),
  z.object({
    ...auditBase,
    action: z.literal("retry_incremented"),
    retryCount: z.number().int().min(1).max(integrationBoundaryLimits.retryAttempts),
    processor: emailIntakeProcessorSchema.optional(),
    reasonCode: emailIntakeReasonCodeSchema.optional(),
  }).strict(),
]);

export const emailIntakeRecordSchema = z.object({
  schemaVersion: z.literal("1.0"),
  intakeId: emailIntakeIdSchema,
  provider: integrationProviderSchema,
  correlationId: correlationIdSchema,
  idempotencyKey: idempotencyKeySchema,
  externalMessageId: externalMessageIdSchema,
  externalThreadId: externalThreadIdSchema.optional(),
  direction: z.enum(["inbound", "outbound"]),
  sender: normalizedEmailAddressSchema,
  recipients: z.array(normalizedEmailAddressSchema).min(1).max(integrationBoundaryLimits.recipients),
  cc: z.array(normalizedEmailAddressSchema).max(integrationBoundaryLimits.recipients).default([]),
  replyTo: normalizedEmailAddressSchema.optional(),
  subject: z.string()
    .trim()
    .max(integrationBoundaryLimits.subjectCharacters)
    .refine((value) => !controlCharacters.test(value), "subject contains control characters")
    .optional(),
  normalizedText: z.string().max(integrationBoundaryLimits.textBodyCharacters).optional(),
  normalizedHtml: z.string().max(integrationBoundaryLimits.htmlBodyCharacters).optional(),
  attachmentSummary: z.array(attachmentMetadataSchema).max(integrationBoundaryLimits.attachments).default([]),
  metadata: boundedMetadataSchema.default({}),
  receivedAt: normalizedIsoTimestampSchema,
  createdAt: normalizedIsoTimestampSchema,
  updatedAt: normalizedIsoTimestampSchema,
  currentStatus: emailIntakeStatusSchema,
  processor: emailIntakeProcessorSchema.optional(),
  retryCount: z.number().int().min(0).max(integrationBoundaryLimits.retryAttempts).default(0),
  auditHistory: z.array(emailIntakeAuditEntrySchema).min(1).max(5_000),
}).strict().superRefine((record, context) => {
  const expectedIdempotencyKey = deriveMessageIdempotencyKey({
    provider: record.provider,
    operation: "message.receive",
    externalMessageId: record.externalMessageId,
  });
  if (record.idempotencyKey !== expectedIdempotencyKey) {
    context.addIssue({ code: "custom", path: ["idempotencyKey"], message: "idempotencyKey does not match external message identity" });
  }
  if (record.createdAt < record.receivedAt) {
    context.addIssue({ code: "custom", path: ["createdAt"], message: "createdAt cannot precede receivedAt" });
  }
  if (record.updatedAt < record.createdAt) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "updatedAt cannot precede createdAt" });
  }
  if (record.auditHistory[0]?.action !== "created") {
    context.addIssue({ code: "custom", path: ["auditHistory"], message: "audit history must begin with created" });
  }
  let previous = "";
  for (const [index, entry] of record.auditHistory.entries()) {
    if (previous && entry.occurredAt < previous) {
      context.addIssue({ code: "custom", path: ["auditHistory", index, "occurredAt"], message: "audit history is not chronological" });
    }
    if (entry.occurredAt > record.updatedAt) {
      context.addIssue({ code: "custom", path: ["auditHistory", index, "occurredAt"], message: "audit entry cannot follow updatedAt" });
    }
    previous = entry.occurredAt;
  }
});

export const emailIntakeRecordListSchema = z.array(emailIntakeRecordSchema).max(100_000);

export const emailIntakeSearchSchema = z.object({
  status: emailIntakeStatusSchema.optional(),
  provider: integrationProviderSchema.optional(),
  sender: z.string().trim().max(320).optional(),
  subject: z.string().trim().max(500).refine((value) => !controlCharacters.test(value)).optional(),
  receivedFrom: normalizedIsoTimestampSchema.optional(),
  receivedTo: normalizedIsoTimestampSchema.optional(),
  correlationId: correlationIdSchema.optional(),
  page: z.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  sortBy: z.enum(["receivedAt", "createdAt", "updatedAt", "subject", "sender", "status", "provider"]).default("receivedAt"),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
}).strict().superRefine((query, context) => {
  if (query.receivedFrom && query.receivedTo && query.receivedFrom > query.receivedTo) {
    context.addIssue({ code: "custom", path: ["receivedTo"], message: "receivedTo cannot precede receivedFrom" });
  }
});

export const emailIntakeExistsQuerySchema = z.object({
  intakeId: emailIntakeIdSchema.optional(),
  provider: integrationProviderSchema.optional(),
  externalMessageId: externalMessageIdSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
}).strict().superRefine((query, context) => {
  const hasExternalPair = Boolean(query.provider && query.externalMessageId);
  if (!query.intakeId && !query.idempotencyKey && !hasExternalPair) {
    context.addIssue({ code: "custom", message: "exists requires intakeId, idempotencyKey, or provider with externalMessageId" });
  }
  if (Boolean(query.provider) !== Boolean(query.externalMessageId)) {
    context.addIssue({ code: "custom", message: "provider and externalMessageId must be supplied together" });
  }
});

export type EmailIntakeStatus = z.infer<typeof emailIntakeStatusSchema>;
export type EmailIntakeAuditEntry = z.infer<typeof emailIntakeAuditEntrySchema>;
export type EmailIntakeRecord = z.infer<typeof emailIntakeRecordSchema>;
export type EmailIntakeSearch = z.input<typeof emailIntakeSearchSchema>;
export type NormalizedEmailIntakeSearch = z.output<typeof emailIntakeSearchSchema>;
export type EmailIntakeExistsQuery = z.input<typeof emailIntakeExistsQuerySchema>;
