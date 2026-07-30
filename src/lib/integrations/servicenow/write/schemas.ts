import { z } from "zod";
import { assertNoSensitiveIntakeData } from "@/lib/intake-core/sensitive-data";
import { containsControlCharacters } from "@/lib/integrations/validation";
import {
  serviceNowWriteCommandTypes,
  serviceNowWriteDeliveryDispositions,
  serviceNowWriteFailurePhases,
  serviceNowWriteReconciliationActions,
  serviceNowWriteSourceTypes,
  serviceNowWriteStatuses,
} from "./types";

const safeText = (label: string, maximum: number, required = false) => {
  const schema = z.string().trim().max(maximum, `${label} is too long`)
    .refine((value) => !containsControlCharacters(value), `${label} contains control characters`);
  return required ? schema.min(1, `${label} is required`) : schema;
};
const optionalText = (label: string, maximum: number) => safeText(label, maximum).optional()
  .transform((value) => value || undefined);
const nullableText = (maximum: number) => z.string().trim().min(1).max(maximum).nullable().optional();
const timestampSchema = z.string().datetime({ offset: true });
const nullableTimestamp = timestampSchema.nullable().optional();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const boundedSafeObject = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 8192) {
    context.addIssue({ code: "custom", message: "Persisted summary is too large" });
  }
  try {
    assertNoSensitiveIntakeData(value);
  } catch {
    context.addIssue({ code: "custom", message: "Persisted summary contains unsafe data" });
  }
});

export const serviceNowWriteCommandTypeSchema = z.enum(serviceNowWriteCommandTypes);
export const serviceNowWriteStatusSchema = z.enum(serviceNowWriteStatuses);
export const serviceNowWriteSourceTypeSchema = z.enum(serviceNowWriteSourceTypes);
export const serviceNowWriteDeliveryDispositionSchema = z.enum(serviceNowWriteDeliveryDispositions);
export const serviceNowWriteFailurePhaseSchema = z.enum(serviceNowWriteFailurePhases);
export const serviceNowWriteReconciliationActionSchema = z.enum(serviceNowWriteReconciliationActions);
export const serviceNowWriteCommandIdSchema = z.string().trim().min(16).max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, "Invalid command ID");
export const serviceNowSysIdWriteSchema = z.string().trim().regex(/^[a-f0-9]{32}$/, "Invalid ServiceNow sys_id");
export const serviceNowNumberWriteSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,80}$/, "Invalid ServiceNow number");
export const serviceNowOperationReferenceSchema = z.string().trim().min(1).max(500)
  .regex(/^[A-Za-z0-9._:-]+$/, "Invalid operation reference");
export const serviceNowSourceEntityReferenceSchema = safeText("Source entity reference", 500, true);
export const serviceNowCorrelationMarkerSchema = z.string().regex(/^SUPPER:[a-f0-9]{64}$/);
export const serviceNowManualOperationTokenSchema = z.string().min(100).max(4096)
  .regex(/^[A-Za-z0-9._-]+$/, "Invalid manual operation token");

const impactUrgency = z.enum(["1", "2", "3"]);
const incidentState = z.enum(["1", "2", "3", "6", "7", "8"]);

const externalReferencesSchema = z.record(
  z.string().trim().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
  safeText("External reference", 500, true),
).superRefine((value, context) => {
  if (Object.keys(value).length > 20 || Buffer.byteLength(JSON.stringify(value), "utf8") > 8192) {
    context.addIssue({ code: "custom", message: "External references are too large" });
  }
  try {
    assertNoSensitiveIntakeData(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "External references contain unsafe data",
    });
  }
}).optional();

export const serviceNowCreateIncidentInputSchema = z.object({
  shortDescription: safeText("Short description", 160, true),
  description: safeText("Description", 20_000, true),
  callerId: serviceNowSysIdWriteSchema.optional(),
  category: optionalText("Category", 100),
  subcategory: optionalText("Subcategory", 100),
  impact: impactUrgency.optional(),
  urgency: impactUrgency.optional(),
  assignmentGroup: serviceNowSysIdWriteSchema.optional(),
  contactChannel: optionalText("Contact channel", 100),
  customer: serviceNowSysIdWriteSchema.optional(),
  projectCode: optionalText("Project code", 200),
  supperTicketNo: optionalText("SUPPER ticket number", 100),
  externalReferences: externalReferencesSchema,
}).strict();

function requireExactlyOneTarget(
  value: { sysId?: string; number?: string },
  context: z.RefinementCtx,
) {
  if (Boolean(value.sysId) === Boolean(value.number)) {
    context.addIssue({
      code: "custom",
      message: "Exactly one of sysId or number is required",
      path: ["sysId"],
    });
  }
}

export const serviceNowUpdateIncidentInputSchema = z.object({
  sysId: serviceNowSysIdWriteSchema.optional(),
  number: serviceNowNumberWriteSchema.optional(),
  shortDescription: optionalText("Short description", 160),
  description: optionalText("Description", 20_000),
  state: incidentState.optional(),
  impact: impactUrgency.optional(),
  urgency: impactUrgency.optional(),
  assignmentGroup: serviceNowSysIdWriteSchema.optional(),
  customer: serviceNowSysIdWriteSchema.optional(),
  projectCode: optionalText("Project code", 200),
}).strict().superRefine((value, context) => {
  requireExactlyOneTarget(value, context);
  const fields = Object.keys(value).filter((key) => key !== "sysId" && key !== "number");
  if (!fields.length) context.addIssue({ code: "custom", message: "At least one update field is required", path: ["shortDescription"] });
});

export const serviceNowJournalInputSchema = z.object({
  sysId: serviceNowSysIdWriteSchema.optional(),
  number: serviceNowNumberWriteSchema.optional(),
  text: safeText("Journal text", 20_000, true),
}).strict().superRefine(requireExactlyOneTarget);

const commonCommand = {
  sourceType: serviceNowWriteSourceTypeSchema,
  sourceEntityReference: serviceNowSourceEntityReferenceSchema.optional(),
  operationReference: serviceNowOperationReferenceSchema.optional(),
  manualOperationToken: serviceNowManualOperationTokenSchema.optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
};

export const createServiceNowWriteCommandRequestSchema = z.discriminatedUnion("commandType", [
  z.object({ commandType: z.literal("create_incident"), ...commonCommand, payload: serviceNowCreateIncidentInputSchema }).strict(),
  z.object({ commandType: z.literal("update_incident"), ...commonCommand, payload: serviceNowUpdateIncidentInputSchema }).strict(),
  z.object({ commandType: z.literal("add_comment"), ...commonCommand, payload: serviceNowJournalInputSchema }).strict(),
  z.object({ commandType: z.literal("add_work_note"), ...commonCommand, payload: serviceNowJournalInputSchema }).strict(),
]).superRefine((value, context) => {
  if (value.sourceType === "manual" && value.operationReference) {
    context.addIssue({ code: "custom", message: "Manual operation reference is generated by the server", path: ["operationReference"] });
  }
  if (value.sourceType === "manual" && !value.manualOperationToken) {
    context.addIssue({ code: "custom", message: "Server-issued manual operation token is required", path: ["manualOperationToken"] });
  }
  if (value.sourceType !== "manual" && value.manualOperationToken) {
    context.addIssue({ code: "custom", message: "Manual operation token is not accepted for this source", path: ["manualOperationToken"] });
  }
  if (value.sourceType !== "manual" && !value.sourceEntityReference) {
    context.addIssue({ code: "custom", message: "Source entity reference is required", path: ["sourceEntityReference"] });
  }
  if (value.sourceType !== "manual" && !value.operationReference) {
    context.addIssue({ code: "custom", message: "Operation reference is required", path: ["operationReference"] });
  }
});

export const issueServiceNowManualOperationRequestSchema = z.object({
  commandType: serviceNowWriteCommandTypeSchema,
  sourceType: z.literal("manual"),
  sourceEntityReference: serviceNowSourceEntityReferenceSchema.optional(),
}).strict();

export const normalizedServiceNowWriteCommandSchema = z.object({
  schemaVersion: z.literal("servicenow-write-normalized-v2"),
  commandType: serviceNowWriteCommandTypeSchema,
  targetSysId: serviceNowSysIdWriteSchema.optional(),
  targetNumber: serviceNowNumberWriteSchema.optional(),
  providerCorrelationMarker: serviceNowCorrelationMarkerSchema.optional(),
  fields: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,79}$/), z.string().min(1).max(20_000)),
}).strict().superRefine((value, context) => {
  if (value.commandType === "create_incident") {
    if (value.targetSysId || value.targetNumber || !value.providerCorrelationMarker) {
      context.addIssue({ code: "custom", message: "Create command target material is invalid" });
    }
  } else {
    if (Boolean(value.targetSysId) === Boolean(value.targetNumber)) {
      context.addIssue({ code: "custom", message: "Exactly one normalized target is required" });
    }
    if (value.providerCorrelationMarker) {
      context.addIssue({ code: "custom", message: "Only create commands may contain a correlation marker" });
    }
  }
});

export const serviceNowSafeRequestSummarySchema = z.object({
  method: z.enum(["GET", "POST", "PATCH"]),
  endpointPath: z.string().min(1).max(500).startsWith("/"),
  targetTable: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
  fieldNames: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,79}$/)).max(30),
  targetSysId: serviceNowSysIdWriteSchema.optional(),
  targetNumber: serviceNowNumberWriteSchema.optional(),
}).strict();

export const serviceNowSafeResponseSummarySchema = z.object({
  httpStatus: z.number().int().min(100).max(599),
  sysId: serviceNowSysIdWriteSchema.optional(),
  number: serviceNowNumberWriteSchema.optional(),
  state: z.string().max(80).optional(),
  recoveredByCorrelationMarker: z.boolean().optional(),
}).strict();

export const serviceNowValidationSummarySchema = z.object({
  valid: z.literal(true),
  mappedFieldCount: z.number().int().min(1).max(30),
  mappedFields: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,79}$/)).min(1).max(30),
  warningCodes: z.array(z.string().regex(/^[A-Z0-9_]{1,80}$/)).max(20),
}).strict();

export const serviceNowWriteConfirmationActionSchema = z.enum([
  "execute",
  "retry",
  ...serviceNowWriteReconciliationActions,
]);

export const issueServiceNowWriteConfirmationRequestSchema = z.object({
  action: serviceNowWriteConfirmationActionSchema,
  expectedVersion: z.number().int().positive(),
  expectedNormalizedPayloadHash: hashSchema,
}).strict();

export const confirmedServiceNowWriteActionRequestSchema = z.object({
  confirmed: z.literal(true),
  expectedVersion: z.number().int().positive(),
  expectedNormalizedPayloadHash: hashSchema,
  confirmationNonce: z.string().min(32).max(200).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

const verificationNoteSchema = safeText("Verification note", 500, true);
export const reconcileServiceNowWriteCommandRequestSchema = z.discriminatedUnion("action", [
  confirmedServiceNowWriteActionRequestSchema.extend({
    action: z.literal("reconcile_by_read_back"),
  }).strict(),
  confirmedServiceNowWriteActionRequestSchema.extend({
    action: z.literal("mark_not_applied_after_verification"),
    verificationAcknowledged: z.literal(true),
    verificationNote: verificationNoteSchema,
  }).strict(),
  confirmedServiceNowWriteActionRequestSchema.extend({
    action: z.literal("mark_succeeded_after_verification"),
    verifiedTargetSysId: serviceNowSysIdWriteSchema,
    verifiedTargetNumber: serviceNowNumberWriteSchema,
    verificationAcknowledged: z.literal(true),
    verificationNote: verificationNoteSchema,
  }).strict(),
]);

export const serviceNowWriteReadinessProofRowSchema = z.object({
  connection_id: z.string().min(1).max(200),
  configuration_fingerprint: hashSchema,
  tested_at: timestampSchema,
  expires_at: timestampSchema,
  test_status: z.enum(["succeeded", "failed"]),
  safe_http_status: z.number().int().min(100).max(599).nullable().optional(),
  tested_by_user_id: z.string().min(1).max(200),
  safe_error_code: nullableText(80),
  updated_at: timestampSchema,
}).strict();

const optionalDate = z.string().date().optional();
export const serviceNowWriteCommandsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: serviceNowWriteStatusSchema.optional(),
  commandType: serviceNowWriteCommandTypeSchema.optional(),
  dateFrom: optionalDate,
  dateTo: optionalDate,
}).strict();

export const serviceNowWriteAttemptRowSchema = z.object({
  id: z.string().min(1).max(200),
  attempt_number: z.number().int().positive(),
  execution_mode: z.enum(["dry_run", "live", "retry"]),
  request_summary: boundedSafeObject,
  response_summary: boundedSafeObject,
  outcome: z.enum(["executing", "dry_run", "succeeded", "failed", "uncertain"]),
  delivery_disposition: serviceNowWriteDeliveryDispositionSchema.nullable().optional(),
  failure_phase: serviceNowWriteFailurePhaseSchema.nullable().optional(),
  retry_allowed: z.boolean(),
  retry_reason: nullableText(240),
  reconciliation_reason: nullableText(240),
  safe_error_code: nullableText(80),
  safe_error_message: nullableText(240),
  started_at: timestampSchema,
  finished_at: nullableTimestamp,
}).strict();

export const serviceNowWriteCommandRowSchema = z.object({
  id: z.string().min(1).max(200),
  version: z.number().int().positive(),
  command_type: serviceNowWriteCommandTypeSchema,
  status: serviceNowWriteStatusSchema,
  source_type: serviceNowWriteSourceTypeSchema,
  source_entity_reference: nullableText(500),
  operation_reference: z.string().min(1).max(500),
  target_table: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
  target_sys_id: serviceNowSysIdWriteSchema.nullable().optional(),
  target_number: serviceNowNumberWriteSchema.nullable().optional(),
  command_material_hash: hashSchema,
  normalized_payload_hash: hashSchema,
  provider_correlation_marker: serviceNowCorrelationMarkerSchema.nullable().optional(),
  normalized_payload: normalizedServiceNowWriteCommandSchema.optional(),
  validation_summary: boundedSafeObject,
  safe_request_summary: boundedSafeObject,
  safe_response_summary: boundedSafeObject,
  delivery_disposition: serviceNowWriteDeliveryDispositionSchema.nullable().optional(),
  failure_phase: serviceNowWriteFailurePhaseSchema.nullable().optional(),
  retry_allowed: z.boolean(),
  retry_reason: nullableText(240),
  reconciliation_reason: nullableText(240),
  reconciliation_checked_at: nullableTimestamp,
  reconciled_by_user_id: nullableText(200),
  reconciliation_result: nullableText(100),
  error_code: nullableText(80),
  error_message: nullableText(240),
  attempt_count: z.number().int().min(0).max(10),
  max_attempts: z.number().int().min(1).max(10),
  next_retry_at: nullableTimestamp,
  last_attempt_at: nullableTimestamp,
  completed_at: nullableTimestamp,
  created_by: z.string().min(1).max(200),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const serviceNowWriteReconciliationEventRowSchema = z.object({
  id: z.string().min(1).max(200),
  action: serviceNowWriteReconciliationActionSchema,
  result: z.string().min(1).max(100),
  safe_read_back_summary: boundedSafeObject,
  actor_user_id: z.string().min(1).max(200),
  command_version_before: z.number().int().positive(),
  command_version_after: z.number().int().positive(),
  created_at: timestampSchema,
}).strict();

export function queryObject(request: Request) {
  return Object.fromEntries(new URL(request.url).searchParams.entries());
}
