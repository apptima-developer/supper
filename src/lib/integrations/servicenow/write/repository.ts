import "server-only";
import { z } from "zod";
import type { JsonObject } from "../../contracts";
import type { ServiceNowEnabledConfig } from "../config";
import { buildServiceNowWritePreview } from "./normalization";
import type {
  NormalizedServiceNowWriteCommand,
  ServiceNowWriteAttemptSummary,
  ServiceNowWriteCommandSummary,
  ServiceNowWriteCommandType,
  ServiceNowWriteOperationsSummary,
  ServiceNowWriteStatus,
} from "./types";
import { serviceNowWriteCommandTypeSchema, serviceNowWriteStatusSchema, serviceNowWriteSourceTypeSchema } from "./schemas";

type JsonRecord = Record<string, unknown>;

async function client() {
  return (await import("../../../supabaseAdmin")).supabaseAdmin;
}

async function must<T>(label: string, promise: PromiseLike<{ data: T; error: { message: string; code?: string } | null; count?: number | null }>) {
  const result = await promise;
  if (result.error) throw Object.assign(new Error(result.error.message || label), {
    code: result.error.code || "SERVICENOW_WRITE_STORAGE_ERROR",
  });
  return result;
}

function text(row: JsonRecord, key: string) {
  return typeof row[key] === "string" && row[key] ? row[key] as string : undefined;
}

function integer(row: JsonRecord, key: string) {
  return typeof row[key] === "number" && Number.isInteger(row[key]) ? row[key] as number : 0;
}

function object(row: JsonRecord, key: string): JsonObject {
  const value = row[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function nextUtcDate(date: string) {
  const exclusive = new Date(`${date}T00:00:00.000Z`);
  exclusive.setUTCDate(exclusive.getUTCDate() + 1);
  return exclusive.toISOString();
}

function attemptSummary(row: JsonRecord): ServiceNowWriteAttemptSummary {
  return {
    id: text(row, "id") || "",
    attemptNumber: integer(row, "attempt_number"),
    executionMode: z.enum(["dry_run", "live", "retry"]).parse(text(row, "execution_mode")),
    requestSummary: object(row, "request_summary"),
    responseSummary: object(row, "response_summary"),
    outcome: z.enum(["executing", "dry_run", "succeeded", "failed"]).parse(text(row, "outcome")),
    safeErrorCode: text(row, "safe_error_code"),
    safeErrorMessage: text(row, "safe_error_message"),
    startedAt: text(row, "started_at") || "",
    finishedAt: text(row, "finished_at"),
  };
}

export function safeServiceNowWriteCommand(
  row: JsonRecord,
  options: { includePreview?: boolean; attempts?: ServiceNowWriteAttemptSummary[] } = {},
): ServiceNowWriteCommandSummary {
  const normalized = object(row, "normalized_payload") as unknown as NormalizedServiceNowWriteCommand;
  return {
    id: text(row, "id") || "",
    commandType: serviceNowWriteCommandTypeSchema.parse(text(row, "command_type")),
    status: serviceNowWriteStatusSchema.parse(text(row, "status")),
    sourceType: serviceNowWriteSourceTypeSchema.parse(text(row, "source_type")),
    sourceReference: text(row, "source_reference") || "",
    targetTable: text(row, "target_table") || "",
    targetSysId: text(row, "target_sys_id"),
    targetNumber: text(row, "target_number"),
    validationSummary: object(row, "validation_summary"),
    safeRequestSummary: object(row, "safe_request_summary"),
    safeResponseSummary: object(row, "safe_response_summary"),
    errorCode: text(row, "error_code"),
    errorMessage: text(row, "error_message"),
    attemptCount: integer(row, "attempt_count"),
    maxAttempts: integer(row, "max_attempts"),
    nextRetryAt: text(row, "next_retry_at"),
    lastAttemptAt: text(row, "last_attempt_at"),
    completedAt: text(row, "completed_at"),
    createdBy: text(row, "created_by") || "",
    createdAt: text(row, "created_at") || "",
    updatedAt: text(row, "updated_at") || "",
    ...(options.includePreview ? { normalizedPreview: buildServiceNowWritePreview(normalized) } : {}),
    ...(options.attempts ? { attempts: options.attempts } : {}),
  };
}

const createResultSchema = z.object({
  action: z.enum(["created", "unchanged"]),
  command_id: z.string(),
  command_status: serviceNowWriteStatusSchema,
  command_attempt_count: z.number().int().nonnegative(),
});

const beginResultSchema = z.object({
  attempt_number: z.number().int().positive(),
  command_type: serviceNowWriteCommandTypeSchema,
  normalized_payload: z.object({
    commandType: serviceNowWriteCommandTypeSchema,
    targetSysId: z.string().optional(),
    targetNumber: z.string().optional(),
    fields: z.record(z.string(), z.string()),
  }).strict(),
  target_table: z.string(),
  target_sys_id: z.string().nullable().optional(),
  target_number: z.string().nullable().optional(),
  max_attempts: z.number().int().positive(),
  live_attempt_count: z.number().int().nonnegative(),
});

const finishResultSchema = z.object({
  command_id: z.string(),
  command_status: serviceNowWriteStatusSchema,
  command_attempt_count: z.number().int().nonnegative(),
  command_next_retry_at: z.string().nullable().optional(),
  command_target_sys_id: z.string().nullable().optional(),
  command_target_number: z.string().nullable().optional(),
});

export class ServiceNowWriteRepository {
  async ensureConnection(id: string, config: ServiceNowEnabledConfig) {
    const db = await client();
    await must("Could not establish ServiceNow write connection", db.from("servicenow_write_connections").upsert({
      id,
      name: `ServiceNow ${new URL(config.instanceUrl).hostname}`,
      active: true,
      auth_mode: config.authMode,
      instance_url: config.instanceUrl,
      incident_table: config.incidentTable,
      timeout_ms: config.timeoutMs,
      metadata: { source: "server_environment" },
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" }));
    return id;
  }

  async getActiveMapping(connectionId: string, commandType: ServiceNowWriteCommandType) {
    const db = await client();
    const result = await must("Could not read ServiceNow write mapping", db.from("servicenow_write_mappings")
      .select("id,field_mapping")
      .eq("connection_id", connectionId)
      .eq("command_type", commandType)
      .eq("active", true)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle());
    const row = result.data as JsonRecord | null;
    return row ? { id: text(row, "id") || "", fieldMapping: object(row, "field_mapping") } : undefined;
  }

  async ensureDefaultMapping(input: {
    id: string;
    connectionId: string;
    commandType: ServiceNowWriteCommandType;
    fieldMapping: Record<string, string>;
  }) {
    const db = await client();
    await must("Could not establish ServiceNow write mapping", db.from("servicenow_write_mappings").upsert({
      id: input.id,
      connection_id: input.connectionId,
      command_type: input.commandType,
      mapping_name: "SUPPER default",
      active: true,
      field_mapping: input.fieldMapping,
      metadata: { source: "application_default" },
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" }));
    return { id: input.id, fieldMapping: input.fieldMapping };
  }

  async createCommand(payload: JsonRecord) {
    const db = await client();
    const result = await must("Could not create ServiceNow write command", db.rpc("support_create_servicenow_write_command", { p_payload: payload }));
    return createResultSchema.parse(Array.isArray(result.data) ? result.data[0] : result.data);
  }

  async getCommand(commandId: string, includeDetails = false) {
    const db = await client();
    const command = await must("Could not read ServiceNow write command", db.from("servicenow_write_commands")
      .select("id,command_type,status,source_type,source_reference,target_table,target_sys_id,target_number,normalized_payload,validation_summary,safe_request_summary,safe_response_summary,error_code,error_message,attempt_count,max_attempts,next_retry_at,last_attempt_at,completed_at,created_by,created_at,updated_at")
      .eq("id", commandId).maybeSingle());
    const row = command.data as JsonRecord | null;
    if (!row) return undefined;
    if (!includeDetails) return safeServiceNowWriteCommand(row);
    const attempts = await must("Could not read ServiceNow write attempts", db.from("servicenow_write_attempts")
      .select("id,attempt_number,execution_mode,request_summary,response_summary,outcome,safe_error_code,safe_error_message,started_at,finished_at")
      .eq("command_id", commandId).order("attempt_number", { ascending: false }).limit(100));
    return safeServiceNowWriteCommand(row, {
      includePreview: true,
      attempts: ((attempts.data || []) as JsonRecord[]).map(attemptSummary),
    });
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
      .select("id,command_type,status,source_type,source_reference,target_table,target_sys_id,target_number,validation_summary,safe_request_summary,safe_response_summary,error_code,error_message,attempt_count,max_attempts,next_retry_at,last_attempt_at,completed_at,created_by,created_at,updated_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .order("id", { ascending: true });
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.commandType) query = query.eq("command_type", filters.commandType);
    if (filters.dateFrom) query = query.gte("created_at", `${filters.dateFrom}T00:00:00.000Z`);
    if (filters.dateTo) query = query.lt("created_at", nextUtcDate(filters.dateTo));
    const from = (filters.page - 1) * filters.limit;
    const result = await must("Could not list ServiceNow write commands", query.range(from, from + filters.limit - 1));
    return {
      items: ((result.data || []) as JsonRecord[]).map((row) => safeServiceNowWriteCommand(row)),
      total: result.count || 0,
      page: filters.page,
      limit: filters.limit,
    };
  }

  async beginAttempt(payload: JsonRecord) {
    const db = await client();
    const result = await must("Could not start ServiceNow write attempt", db.rpc("support_begin_servicenow_write_attempt", { p_payload: payload }));
    return beginResultSchema.parse(Array.isArray(result.data) ? result.data[0] : result.data);
  }

  async finishAttempt(payload: JsonRecord) {
    const db = await client();
    const result = await must("Could not finish ServiceNow write attempt", db.rpc("support_finish_servicenow_write_attempt", { p_payload: payload }));
    return finishResultSchema.parse(Array.isArray(result.data) ? result.data[0] : result.data);
  }

  async getOperationsSummary(): Promise<Omit<ServiceNowWriteOperationsSummary, "readiness">> {
    const db = await client();
    const statuses: ServiceNowWriteStatus[] = [
      "pending", "validated", "dry_run_ready", "executing", "succeeded", "failed", "retry_scheduled", "cancelled",
    ];
    const [latest, latestDryRun, ...counts] = await Promise.all([
      must("Could not read latest ServiceNow write command", db.from("servicenow_write_commands")
        .select("id,command_type,status,source_type,source_reference,target_table,target_sys_id,target_number,validation_summary,safe_request_summary,safe_response_summary,error_code,error_message,attempt_count,max_attempts,next_retry_at,last_attempt_at,completed_at,created_by,created_at,updated_at")
        .order("created_at", { ascending: false }).limit(1).maybeSingle()),
      must("Could not read latest ServiceNow dry run", db.from("servicenow_write_attempts")
        .select("id,attempt_number,execution_mode,request_summary,response_summary,outcome,safe_error_code,safe_error_message,started_at,finished_at")
        .eq("execution_mode", "dry_run").order("started_at", { ascending: false }).limit(1).maybeSingle()),
      ...statuses.map((status) => must(`Could not count ${status} ServiceNow commands`, db.from("servicenow_write_commands")
        .select("id", { count: "exact", head: true }).eq("status", status))),
    ]);
    const latestRow = latest.data as JsonRecord | null;
    const latestDryRunRow = latestDryRun.data as JsonRecord | null;
    const countsByStatus: Partial<Record<ServiceNowWriteStatus, number>> = {};
    statuses.forEach((status, index) => {
      countsByStatus[status] = counts[index].count || 0;
    });
    return {
      latestCommand: latestRow ? safeServiceNowWriteCommand(latestRow) : undefined,
      latestDryRun: latestDryRunRow ? attemptSummary(latestDryRunRow) : undefined,
      countsByStatus,
      lastSafeErrorCode: latestRow ? text(latestRow, "error_code") : undefined,
      lastSafeErrorMessage: latestRow ? text(latestRow, "error_message") : undefined,
    };
  }
}
