import "server-only";
import { z } from "zod";
import type { JsonObject } from "../../contracts";
import type { ServiceNowEnabledConfig } from "../config";
import { buildServiceNowWritePreview } from "./normalization";
import {
  normalizedServiceNowWriteCommandSchema,
  serviceNowWriteAttemptRowSchema,
  serviceNowWriteCommandRowSchema,
  serviceNowWriteCommandTypeSchema,
  serviceNowWriteMutationCandidateRowSchema,
  serviceNowWriteReconciliationEventRowSchema,
  serviceNowWriteReconciliationResultSchema,
  serviceNowWriteReadinessProofRowSchema,
  serviceNowWriteStatusSchema,
} from "./schemas";
import type {
  ServiceNowWriteAttemptSummary,
  ServiceNowWriteCommandSummary,
  ServiceNowWriteCommandType,
  ServiceNowWriteMutationCandidate,
  ServiceNowWriteOperationsSummary,
  ServiceNowWriteStatus,
} from "./types";

async function client() {
  return (await import("../../../supabaseAdmin")).supabaseAdmin;
}

async function must<T>(
  label: string,
  promise: PromiseLike<{ data: T; error: { message: string; code?: string } | null; count?: number | null }>,
) {
  const result = await promise;
  if (result.error) throw Object.assign(new Error(result.error.message || label), {
    code: result.error.code || "SERVICENOW_WRITE_STORAGE_ERROR",
  });
  return result;
}

function asJsonObject(value: Record<string, unknown>) {
  return value as JsonObject;
}

function storageIntegrityError(): never {
  throw Object.assign(new Error("Stored ServiceNow write data failed integrity validation"), {
    code: "SERVICENOW_WRITE_STORAGE_INTEGRITY_ERROR",
  });
}

function parsePersisted<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) storageIntegrityError();
  return result.data;
}

function nextUtcDate(date: string) {
  const exclusive = new Date(`${date}T00:00:00.000Z`);
  exclusive.setUTCDate(exclusive.getUTCDate() + 1);
  return exclusive.toISOString();
}

function attemptSummary(input: unknown): ServiceNowWriteAttemptSummary {
  const row = parsePersisted(serviceNowWriteAttemptRowSchema, input);
  return {
    id: row.id,
    attemptNumber: row.attempt_number,
    executionMode: row.execution_mode,
    requestSummary: asJsonObject(row.request_summary),
    responseSummary: asJsonObject(row.response_summary),
    outcome: row.outcome,
    deliveryDisposition: row.delivery_disposition || undefined,
    failurePhase: row.failure_phase || undefined,
    retryAllowed: row.retry_allowed,
    retryReason: row.retry_reason || undefined,
    reconciliationReason: row.reconciliation_reason || undefined,
    safeErrorCode: row.safe_error_code || undefined,
    safeErrorMessage: row.safe_error_message || undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at || undefined,
  };
}

export function safeServiceNowWriteCommand(
  input: unknown,
  options: {
    includePreview?: boolean;
    attempts?: ServiceNowWriteAttemptSummary[];
    mutationCandidate?: ServiceNowWriteMutationCandidate;
    reconciliationHistory?: ServiceNowWriteCommandSummary["reconciliationHistory"];
  } = {},
): ServiceNowWriteCommandSummary {
  const row = parsePersisted(serviceNowWriteCommandRowSchema, input);
  let normalized;
  if (options.includePreview) {
    normalized = parsePersisted(normalizedServiceNowWriteCommandSchema, row.normalized_payload);
  }
  return {
    id: row.id,
    version: row.version,
    commandType: row.command_type,
    status: row.status,
    sourceType: row.source_type,
    sourceEntityReference: row.source_entity_reference || undefined,
    operationReference: row.operation_reference,
    targetTable: row.target_table,
    targetSysId: row.target_sys_id || undefined,
    targetNumber: row.target_number || undefined,
    ...(options.mutationCandidate ? { mutationCandidate: options.mutationCandidate } : {}),
    commandMaterialHash: row.command_material_hash,
    normalizedPayloadHash: row.normalized_payload_hash,
    providerCorrelationMarker: row.provider_correlation_marker || undefined,
    validationSummary: asJsonObject(row.validation_summary),
    safeRequestSummary: asJsonObject(row.safe_request_summary),
    safeResponseSummary: asJsonObject(row.safe_response_summary),
    deliveryDisposition: row.delivery_disposition || undefined,
    failurePhase: row.failure_phase || undefined,
    retryAllowed: row.retry_allowed,
    retryReason: row.retry_reason || undefined,
    reconciliationReason: row.reconciliation_reason || undefined,
    reconciliationCheckedAt: row.reconciliation_checked_at || undefined,
    reconciledByUserId: row.reconciled_by_user_id || undefined,
    reconciliationResult: row.reconciliation_result || undefined,
    errorCode: row.error_code || undefined,
    errorMessage: row.error_message || undefined,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextRetryAt: row.next_retry_at || undefined,
    lastAttemptAt: row.last_attempt_at || undefined,
    completedAt: row.completed_at || undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(normalized ? { normalizedPreview: buildServiceNowWritePreview(normalized) } : {}),
    ...(options.attempts ? { attempts: options.attempts } : {}),
    ...(options.reconciliationHistory ? { reconciliationHistory: options.reconciliationHistory } : {}),
  };
}

const createResultSchema = z.object({
  action: z.enum(["created", "unchanged"]),
  command_id: z.string(),
  command_status: serviceNowWriteStatusSchema,
  command_attempt_count: z.number().int().nonnegative(),
  command_version: z.number().int().positive(),
  command_material_hash: z.string().regex(/^[a-f0-9]{64}$/),
  normalized_payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
});

const beginResultSchema = z.object({
  attempt_number: z.number().int().positive(),
  command_type: serviceNowWriteCommandTypeSchema,
  normalized_payload: normalizedServiceNowWriteCommandSchema,
  target_table: z.string(),
  target_sys_id: z.string().nullable().optional(),
  target_number: z.string().nullable().optional(),
  max_attempts: z.number().int().positive(),
  live_attempt_count: z.number().int().nonnegative(),
  command_version: z.number().int().positive(),
});

const finishResultSchema = z.object({
  command_id: z.string(),
  command_status: serviceNowWriteStatusSchema,
  command_attempt_count: z.number().int().nonnegative(),
  command_next_retry_at: z.string().nullable().optional(),
  command_target_sys_id: z.string().nullable().optional(),
  command_target_number: z.string().nullable().optional(),
  command_version: z.number().int().positive(),
});

const confirmationResultSchema = z.object({
  command_id: z.string(),
  command_version: z.number().int().positive(),
  normalized_payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation_expires_at: z.string().datetime({ offset: true }),
});

const reconciliationResultSchema = z.object({
  command_id: z.string(),
  command_status: serviceNowWriteStatusSchema,
  command_version: z.number().int().positive(),
  reconciliation_result: serviceNowWriteReconciliationResultSchema,
});

const readinessProofResultSchema = z.object({
  connection_id: z.string().min(1).max(200),
  configuration_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  tested_at: z.string().datetime({ offset: true }),
  expires_at: z.string().datetime({ offset: true }),
  test_status: z.enum(["succeeded", "failed"]),
  safe_http_status: z.number().int().min(100).max(599).nullable().optional(),
  safe_error_code: z.string().min(1).max(80).nullable().optional(),
});

const mappingSelect = "id,field_mapping";
const commandSelect = [
  "id", "version", "command_type", "status", "source_type", "source_entity_reference",
  "operation_reference", "target_table", "target_sys_id", "target_number",
  "command_material_hash", "normalized_payload_hash", "provider_correlation_marker", "validation_summary",
  "safe_request_summary", "safe_response_summary", "delivery_disposition",
  "failure_phase", "retry_allowed", "retry_reason", "reconciliation_reason",
  "reconciliation_checked_at", "reconciled_by_user_id", "reconciliation_result",
  "error_code", "error_message", "attempt_count", "max_attempts", "next_retry_at",
  "last_attempt_at", "completed_at", "created_by", "created_at", "updated_at",
].join(",");
const detailedCommandSelect = `${commandSelect},normalized_payload`;
const attemptSelect = [
  "id", "attempt_number", "execution_mode", "request_summary", "response_summary",
  "outcome", "delivery_disposition", "failure_phase", "retry_allowed", "retry_reason",
  "reconciliation_reason", "safe_error_code", "safe_error_message", "started_at", "finished_at",
].join(",");
const reconciliationSelect = [
  "id", "action", "result", "evidence_classification", "safe_read_back_summary", "actor_user_id",
  "command_version_before", "command_version_after", "created_at",
].join(",");
const mutationCandidateSelect = "command_id,attempt_id,sys_id,number,http_status,observed_at,source";

function mutationCandidateSummary(input: unknown): ServiceNowWriteMutationCandidate | undefined {
  const row = parsePersisted(serviceNowWriteMutationCandidateRowSchema.nullable(), input);
  return row
    ? {
      sysId: row.sys_id,
      number: row.number,
      httpStatus: row.http_status,
      observedAt: row.observed_at,
      source: row.source,
    }
    : undefined;
}

export class ServiceNowWriteRepository {
  async ensureConnection(
    id: string,
    config: ServiceNowEnabledConfig,
    configurationFingerprint: string,
    credentialVersion: string,
  ) {
    const db = await client();
    const result = await must("Could not establish ServiceNow write connection", db.rpc(
      "support_upsert_servicenow_write_connection",
      {
        p_payload: {
          id,
          name: `ServiceNow ${new URL(config.instanceUrl).hostname}`,
          active: true,
          authMode: config.authMode,
          instanceUrl: config.instanceUrl,
          incidentTable: config.incidentTable,
          configVersion: credentialVersion,
          configurationFingerprint,
          timeoutMs: config.timeoutMs,
          metadata: { source: "server_environment" },
          updatedAt: new Date().toISOString(),
        },
      },
    ));
    const row = z.object({ id: z.string().min(1) }).parse(Array.isArray(result.data) ? result.data[0] : result.data);
    return row.id;
  }

  async getReadinessProof(connectionId: string) {
    const db = await client();
    const result = await must("Could not read ServiceNow readiness proof", db.from("servicenow_write_readiness_proofs")
      .select("connection_id,configuration_fingerprint,tested_at,expires_at,test_status,safe_http_status,tested_by_user_id,safe_error_code,updated_at")
      .eq("connection_id", connectionId)
      .maybeSingle());
    return parsePersisted(serviceNowWriteReadinessProofRowSchema.nullable(), result.data);
  }

  async recordReadinessProof(payload: Record<string, unknown>) {
    const db = await client();
    const result = await must(
      "Could not persist ServiceNow readiness proof",
      db.rpc("support_record_servicenow_write_readiness", { p_payload: payload }),
    );
    return readinessProofResultSchema.parse(Array.isArray(result.data) ? result.data[0] : result.data);
  }

  async getActiveMapping(connectionId: string, commandType: ServiceNowWriteCommandType) {
    const db = await client();
    const result = await must("Could not read ServiceNow write mapping", db.from("servicenow_write_mappings")
      .select(mappingSelect)
      .eq("connection_id", connectionId)
      .eq("command_type", commandType)
      .eq("active", true)
      .limit(1)
      .maybeSingle());
    const row = parsePersisted(z.object({
      id: z.string().min(1),
      field_mapping: z.record(z.string(), z.string()),
    }).strict().nullable(), result.data);
    return row ? { id: row.id, fieldMapping: row.field_mapping } : undefined;
  }

  async ensureDefaultMapping(input: {
    id: string;
    connectionId: string;
    commandType: ServiceNowWriteCommandType;
    fieldMapping: Record<string, string>;
  }) {
    const db = await client();
    const result = await must("Could not establish ServiceNow write mapping", db.rpc(
      "support_upsert_servicenow_write_mapping",
      {
        p_payload: {
          id: input.id,
          connectionId: input.connectionId,
          commandType: input.commandType,
          mappingName: "SUPPER default",
          active: true,
          fieldMapping: input.fieldMapping,
          metadata: { source: "application_default" },
          updatedAt: new Date().toISOString(),
        },
      },
    ));
    const row = z.object({
      id: z.string().min(1),
      field_mapping: z.record(z.string(), z.string()),
    }).parse(Array.isArray(result.data) ? result.data[0] : result.data);
    return { id: row.id, fieldMapping: row.field_mapping };
  }

  async createCommand(payload: Record<string, unknown>) {
    const db = await client();
    const result = await must("Could not create ServiceNow write command", db.rpc("support_create_servicenow_write_command", { p_payload: payload }));
    return createResultSchema.parse(Array.isArray(result.data) ? result.data[0] : result.data);
  }

  async issueConfirmation(payload: Record<string, unknown>) {
    const db = await client();
    const result = await must("Could not issue ServiceNow write confirmation", db.rpc("support_issue_servicenow_write_confirmation", { p_payload: payload }));
    return confirmationResultSchema.parse(Array.isArray(result.data) ? result.data[0] : result.data);
  }

  async getCommand(commandId: string, includeDetails = false) {
    const db = await client();
    const command = await must("Could not read ServiceNow write command", db.from("servicenow_write_commands")
      .select(includeDetails ? detailedCommandSelect : commandSelect)
      .eq("id", commandId).maybeSingle());
    if (!command.data) return undefined;
    if (!includeDetails) return safeServiceNowWriteCommand(command.data);
    const [attempts, reconciliation, mutationCandidate] = await Promise.all([
      must("Could not read ServiceNow write attempts", db.from("servicenow_write_attempts")
        .select(attemptSelect)
        .eq("command_id", commandId).order("attempt_number", { ascending: false }).limit(100)),
      must("Could not read ServiceNow reconciliation history", db.from("servicenow_write_reconciliation_events")
        .select(reconciliationSelect)
        .eq("command_id", commandId).order("created_at", { ascending: false }).limit(100)),
      must("Could not read ServiceNow mutation candidate", db.from("servicenow_write_mutation_candidates")
        .select(mutationCandidateSelect)
        .eq("command_id", commandId).maybeSingle()),
    ]);
    const history = parsePersisted(z.array(serviceNowWriteReconciliationEventRowSchema), reconciliation.data || []).map((row) => ({
      id: row.id,
      action: row.action,
      result: row.result,
      evidenceClassification: row.evidence_classification,
      safeReadBackSummary: asJsonObject(row.safe_read_back_summary),
      actorUserId: row.actor_user_id,
      commandVersionBefore: row.command_version_before,
      commandVersionAfter: row.command_version_after,
      createdAt: row.created_at,
    }));
    return safeServiceNowWriteCommand(command.data, {
      includePreview: true,
      attempts: parsePersisted(z.array(serviceNowWriteAttemptRowSchema), attempts.data || []).map(attemptSummary),
      mutationCandidate: mutationCandidateSummary(mutationCandidate.data),
      reconciliationHistory: history,
    });
  }

  async getMutationCandidate(commandId: string) {
    const db = await client();
    const result = await must(
      "Could not read ServiceNow mutation candidate",
      db.from("servicenow_write_mutation_candidates")
        .select(mutationCandidateSelect)
        .eq("command_id", commandId)
        .maybeSingle(),
    );
    return mutationCandidateSummary(result.data);
  }

  async getNormalizedCommand(commandId: string) {
    const db = await client();
    const result = await must("Could not read ServiceNow normalized command", db.from("servicenow_write_commands")
      .select("normalized_payload")
      .eq("id", commandId).maybeSingle());
    const row = parsePersisted(
      z.object({ normalized_payload: normalizedServiceNowWriteCommandSchema }).strict().nullable(),
      result.data,
    );
    if (!row) return undefined;
    return row.normalized_payload;
  }

  async getCommandExecutionContext(commandId: string) {
    const db = await client();
    const result = await must("Could not read ServiceNow command execution context", db.from("servicenow_write_commands")
      .select("connection_id,normalized_payload")
      .eq("id", commandId).maybeSingle());
    return parsePersisted(z.object({
      connection_id: z.string().min(1).max(200),
      normalized_payload: normalizedServiceNowWriteCommandSchema,
    }).strict().nullable(), result.data);
  }

  async listCommands(filters: {
    page: number;
    limit: number;
    status?: ServiceNowWriteStatus;
    commandType?: ServiceNowWriteCommandType;
    dateFrom?: string;
    dateTo?: string;
  }) {
    const db = await client();
    let query = db.from("servicenow_write_commands")
      .select(commandSelect, { count: "exact" })
      .order("created_at", { ascending: false })
      .order("id", { ascending: true });
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.commandType) query = query.eq("command_type", filters.commandType);
    if (filters.dateFrom) query = query.gte("created_at", `${filters.dateFrom}T00:00:00.000Z`);
    if (filters.dateTo) query = query.lt("created_at", nextUtcDate(filters.dateTo));
    const from = (filters.page - 1) * filters.limit;
    const result = await must("Could not list ServiceNow write commands", query.range(from, from + filters.limit - 1));
    return {
      items: parsePersisted(z.array(serviceNowWriteCommandRowSchema), result.data || [])
        .map((row) => safeServiceNowWriteCommand(row)),
      total: result.count || 0,
      page: filters.page,
      limit: filters.limit,
    };
  }

  async beginAttempt(payload: Record<string, unknown>) {
    const db = await client();
    const result = await must("Could not start ServiceNow write attempt", db.rpc("support_begin_servicenow_write_attempt", { p_payload: payload }));
    return beginResultSchema.parse(Array.isArray(result.data) ? result.data[0] : result.data);
  }

  async finishAttempt(payload: Record<string, unknown>) {
    const db = await client();
    const result = await must("Could not finish ServiceNow write attempt", db.rpc("support_finish_servicenow_write_attempt", { p_payload: payload }));
    return finishResultSchema.parse(Array.isArray(result.data) ? result.data[0] : result.data);
  }

  async reconcile(payload: Record<string, unknown>) {
    const db = await client();
    const result = await must("Could not reconcile ServiceNow write command", db.rpc("support_reconcile_servicenow_write_command", { p_payload: payload }));
    return reconciliationResultSchema.parse(Array.isArray(result.data) ? result.data[0] : result.data);
  }

  async getOperationsSummary(): Promise<Omit<ServiceNowWriteOperationsSummary, "readiness">> {
    const db = await client();
    const statuses: ServiceNowWriteStatus[] = [
      "pending", "validated", "dry_run_ready", "executing", "succeeded", "failed",
      "retry_scheduled", "reconciliation_required", "cancelled",
    ];
    const [latest, latestDryRun, ...counts] = await Promise.all([
      must("Could not read latest ServiceNow write command", db.from("servicenow_write_commands")
        .select(commandSelect)
        .order("created_at", { ascending: false }).limit(1).maybeSingle()),
      must("Could not read latest ServiceNow dry run", db.from("servicenow_write_attempts")
        .select(attemptSelect)
        .eq("execution_mode", "dry_run").order("started_at", { ascending: false }).limit(1).maybeSingle()),
      ...statuses.map((status) => must(`Could not count ${status} ServiceNow commands`, db.from("servicenow_write_commands")
        .select("id", { count: "exact", head: true }).eq("status", status))),
    ]);
    const countsByStatus: Partial<Record<ServiceNowWriteStatus, number>> = {};
    statuses.forEach((status, index) => {
      countsByStatus[status] = counts[index].count || 0;
    });
    const latestCommand = latest.data ? safeServiceNowWriteCommand(latest.data) : undefined;
    return {
      latestCommand,
      latestDryRun: latestDryRun.data ? attemptSummary(latestDryRun.data) : undefined,
      countsByStatus,
      lastSafeErrorCode: latestCommand?.errorCode,
      lastSafeErrorMessage: latestCommand?.errorMessage,
    };
  }
}
