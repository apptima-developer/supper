import "server-only";
import { createHash } from "node:crypto";
import type { Session } from "../../../auth";
import { getDataBackend } from "../../../env";
import { writeAudit } from "../../../repositories";
import { HttpError } from "../../../request-security";
import { logServerCritical } from "../../../server-logging";
import { isIntegrationBoundaryError } from "../../errors";
import { correlationIdSchema } from "../../schemas";
import { parseServiceNowConfig, summarizeServiceNowConfig, type ServiceNowEnabledConfig } from "../config";
import { serviceNowDefaultWriteMapping, validateServiceNowWriteFieldMapping, normalizeCommand } from "./normalization";
import { buildServiceNowNormalizedPayloadHash, buildServiceNowWriteIdempotencyKey } from "./idempotency";
import { ServiceNowWriteAdapter } from "./adapter";
import { parseServiceNowWriteConfig } from "./config";
import { ServiceNowWriteRepository } from "./repository";
import { createServiceNowWriteCommandRequestSchema } from "./schemas";
import type {
  ServiceNowWriteCommandInput,
  ServiceNowWriteCommandSummary,
  ServiceNowWriteReadiness,
} from "./types";

type AuditWriter = typeof writeAudit;
type Dependencies = {
  env?: Record<string, string | undefined>;
  repository?: ServiceNowWriteRepository;
  adapter?: Pick<ServiceNowWriteAdapter, "preview" | "execute" | "testReadiness">;
  fetch?: typeof fetch;
  audit?: AuditWriter;
  now?: () => Date;
  createId?: () => string;
};

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function runtimeConnectionId(config: ServiceNowEnabledConfig) {
  return `sn-write-${digest(`${config.instanceUrl}|${config.incidentTable}`).slice(0, 40)}`;
}

function defaultMappingId(connectionId: string, commandType: string) {
  return `sn-map-${digest(`${connectionId}|${commandType}|default`).slice(0, 40)}`;
}

function requireRelational(env: Record<string, string | undefined>) {
  if (getDataBackend(env) !== "supabase-relational") {
    throw new HttpError(503, "SERVICENOW_WRITE_REQUIRES_RELATIONAL", "ServiceNow writes require relational storage");
  }
}

function requireServiceNowConfig(env: Record<string, string | undefined>) {
  try {
    const config = parseServiceNowConfig(env);
    if (!config.enabled) throw new HttpError(503, "SERVICENOW_DISABLED", "ServiceNow integration is disabled");
    return config;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "SERVICENOW_CONFIGURATION_INVALID", "ServiceNow configuration is invalid");
  }
}

function operationalError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("SERVICENOW_WRITE_IDEMPOTENCY_CONFLICT")) throw new HttpError(409, "SERVICENOW_WRITE_IDEMPOTENCY_CONFLICT", "The source reference is already associated with different command material");
  if (message.includes("SERVICENOW_WRITE_COMMAND_NOT_FOUND")) throw new HttpError(404, "SERVICENOW_WRITE_COMMAND_NOT_FOUND", "ServiceNow write command was not found");
  if (message.includes("SERVICENOW_WRITE_COMMAND_BUSY")) throw new HttpError(409, "SERVICENOW_WRITE_COMMAND_BUSY", "ServiceNow write command is already executing");
  if (message.includes("SERVICENOW_WRITE_ATTEMPTS_EXHAUSTED")) throw new HttpError(409, "SERVICENOW_WRITE_ATTEMPTS_EXHAUSTED", "ServiceNow write retry limit has been reached");
  if (message.includes("SERVICENOW_WRITE_SOURCE_NOT_FOUND")) throw new HttpError(409, "SERVICENOW_WRITE_SOURCE_NOT_FOUND", "The linked SUPPER source record was not found");
  if (message.includes("SERVICENOW_WRITE_DRY_RUN_NOT_ALLOWED")
    || message.includes("SERVICENOW_WRITE_EXECUTION_NOT_ALLOWED")
    || message.includes("SERVICENOW_WRITE_RETRY_NOT_ALLOWED")) {
    throw new HttpError(409, "SERVICENOW_WRITE_TRANSITION_NOT_ALLOWED", "ServiceNow write command cannot perform this transition");
  }
  if (message.includes("SERVICENOW_WRITE_CONNECTION_UNAVAILABLE")) throw new HttpError(503, "SERVICENOW_WRITE_CONNECTION_UNAVAILABLE", "ServiceNow write connection is unavailable");
  if (message.includes("SERVICENOW_WRITE_MAPPING_UNAVAILABLE")) throw new HttpError(409, "SERVICENOW_WRITE_MAPPING_UNAVAILABLE", "ServiceNow write mapping is unavailable");
  throw error;
}

async function auditBestEffort(
  command: ServiceNowWriteCommandSummary,
  session: Session,
  event: "created" | "dry_run" | "executed" | "retried",
  requestId: string,
  audit: AuditWriter,
) {
  try {
    await audit({
      action: event === "created" ? "create" : "update",
      entity: "servicenow-write-command",
      entityId: command.id,
      actor: session.username,
      details: {
        provider: "servicenow",
        event,
        commandType: command.commandType,
        status: command.status,
        sourceType: command.sourceType,
        sourceReference: command.sourceReference,
        attemptCount: command.attemptCount,
        targetNumber: command.targetNumber || null,
      },
    });
    return command;
  } catch (error) {
    logServerCritical("SERVICENOW_WRITE_SUCCEEDED_AUDIT_FAILED", error, {
      requestId,
      operation: `servicenow.write.${event}`,
      commandId: command.id,
      status: command.status,
    });
    return { ...command, auditWarning: "secondary_audit_write_failed" as const };
  }
}

async function runtime(dependencies: Dependencies, requireWriteEnabled: boolean) {
  const env = dependencies.env || process.env;
  requireRelational(env);
  const config = requireServiceNowConfig(env);
  const writeConfig = parseServiceNowWriteConfig(env);
  if (requireWriteEnabled && !writeConfig.enabled) {
    throw new HttpError(503, "SERVICENOW_WRITE_DISABLED", "ServiceNow write execution is disabled");
  }
  const repository = dependencies.repository || new ServiceNowWriteRepository();
  const adapter = dependencies.adapter || new ServiceNowWriteAdapter(config, { fetch: dependencies.fetch || fetch });
  return { env, config, writeConfig, repository, adapter };
}

export function validateCommand(input: unknown): ServiceNowWriteCommandInput {
  return createServiceNowWriteCommandRequestSchema.parse(input);
}

export async function createCommand(
  input: ServiceNowWriteCommandInput & { session: Session; requestId: string; correlationId: string },
  dependencies: Dependencies = {},
) {
  const { session, requestId, correlationId, ...commandInput } = input;
  const validated = validateCommand(commandInput);
  const { config, writeConfig, repository } = await runtime(dependencies, false);
  const connectionId = runtimeConnectionId(config);
  await repository.ensureConnection(connectionId, config);
  let mapping = await repository.getActiveMapping(connectionId, validated.commandType);
  if (!mapping) {
    const fieldMapping = serviceNowDefaultWriteMapping(validated.commandType);
    mapping = await repository.ensureDefaultMapping({
      id: defaultMappingId(connectionId, validated.commandType),
      connectionId,
      commandType: validated.commandType,
      fieldMapping,
    });
  }
  const safeMapping = validateServiceNowWriteFieldMapping(validated.commandType, mapping.fieldMapping);
  const normalized = normalizeCommand(validated, safeMapping);
  const idempotencyKey = buildServiceNowWriteIdempotencyKey(validated, connectionId, config.incidentTable);
  const normalizedPayloadHash = buildServiceNowNormalizedPayloadHash(normalized);
  const now = (dependencies.now || (() => new Date()))().toISOString();
  const createId = dependencies.createId || (() => crypto.randomUUID());
  try {
    const result = await repository.createCommand({
      commandId: createId(),
      commandType: validated.commandType,
      idempotencyKey,
      normalizedPayloadHash,
      connectionId,
      mappingId: mapping.id,
      sourceType: validated.sourceType,
      sourceReference: validated.sourceReference,
      targetTable: config.incidentTable,
      targetSysId: normalized.targetSysId || "",
      targetNumber: normalized.targetNumber || "",
      payload: validated.payload,
      normalizedPayload: normalized,
      validationSummary: {
        valid: true,
        mappedFieldCount: Object.keys(normalized.fields).length,
        mappedFields: Object.keys(normalized.fields).sort(),
        warningCodes: [],
      },
      maxAttempts: Math.min(validated.maxAttempts || writeConfig.maxAttempts, writeConfig.maxAttempts),
      createdBy: session.userId,
      requestId,
      correlationId,
      createdAt: now,
    });
    const command = await repository.getCommand(result.command_id, true);
    if (!command) throw new Error("ServiceNow write command disappeared after creation");
    return result.action === "created"
      ? auditBestEffort(command, session, "created", requestId, dependencies.audit || writeAudit)
      : command;
  } catch (error) {
    operationalError(error);
  }
}

function retryDelayMilliseconds(attemptCount: number) {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attemptCount - 1));
}

async function execute(
  input: {
    commandId: string;
    session: Session;
    requestId: string;
    correlationId: string;
    abortSignal?: AbortSignal;
  },
  mode: "dry_run" | "live" | "retry",
  dependencies: Dependencies,
) {
  const live = mode !== "dry_run";
  const { repository, adapter } = await runtime(dependencies, live);
  const now = dependencies.now || (() => new Date());
  const createId = dependencies.createId || (() => crypto.randomUUID());
  const startedAt = now();
  const attemptId = createId();
  let started;
  try {
    started = await repository.beginAttempt({
      commandId: input.commandId,
      attemptId,
      executionMode: mode,
      retry: mode === "retry",
      requestId: input.requestId,
      startedAt: startedAt.toISOString(),
    });
  } catch (error) {
    operationalError(error);
  }

  const normalized = started.normalized_payload;
  const requestSummary = adapter.preview(normalized);
  if (mode === "dry_run") {
    try {
      await repository.finishAttempt({
        commandId: input.commandId,
        attemptId,
        outcome: "dry_run",
        retryable: false,
        requestSummary,
        responseSummary: { validated: true, providerWritePerformed: false },
        targetSysId: normalized.targetSysId || "",
        targetNumber: normalized.targetNumber || "",
        errorCode: "",
        errorMessage: "",
        finishedAt: now().toISOString(),
      });
      const command = await repository.getCommand(input.commandId, true);
      if (!command) throw new Error("ServiceNow write command disappeared after dry run");
      return auditBestEffort(command, input.session, "dry_run", input.requestId, dependencies.audit || writeAudit);
    } catch (error) {
      operationalError(error);
    }
  }

  try {
    const result = await adapter.execute(
      normalized,
      correlationIdSchema.parse(input.correlationId),
      input.abortSignal,
    );
    await repository.finishAttempt({
      commandId: input.commandId,
      attemptId,
      outcome: "succeeded",
      retryable: false,
      requestSummary: result.requestSummary,
      responseSummary: result.responseSummary,
      targetSysId: result.targetSysId,
      targetNumber: result.targetNumber,
      errorCode: "",
      errorMessage: "",
      finishedAt: now().toISOString(),
    });
  } catch (error) {
    if (!isIntegrationBoundaryError(error)) {
      logServerCritical("SERVICENOW_WRITE_EXECUTION_STATE_UNCERTAIN", error, {
        requestId: input.requestId,
        operation: "servicenow.write.execute",
        commandId: input.commandId,
        attemptId,
      });
      throw error;
    }
    const finishedAt = now();
    try {
      await repository.finishAttempt({
        commandId: input.commandId,
        attemptId,
        outcome: "failed",
        retryable: error.retryable,
        requestSummary,
        responseSummary: {},
        targetSysId: normalized.targetSysId || "",
        targetNumber: normalized.targetNumber || "",
        errorCode: error.code,
        errorMessage: error.safeMessage,
        nextRetryAt: new Date(finishedAt.getTime() + retryDelayMilliseconds(started.live_attempt_count)).toISOString(),
        finishedAt: finishedAt.toISOString(),
      });
    } catch (storageError) {
      logServerCritical("SERVICENOW_WRITE_FAILURE_PERSISTENCE_FAILED", storageError, {
        requestId: input.requestId,
        operation: "servicenow.write.execute",
        commandId: input.commandId,
        attemptId,
        providerErrorCode: error.code,
      });
      throw storageError;
    }
  }

  const command = await repository.getCommand(input.commandId, true);
  if (!command) throw new Error("ServiceNow write command disappeared after execution");
  return auditBestEffort(
    command,
    input.session,
    mode === "retry" ? "retried" : "executed",
    input.requestId,
    dependencies.audit || writeAudit,
  );
}

export function executeCommandDryRun(
  input: { commandId: string; session: Session; requestId: string; correlationId: string },
  dependencies: Dependencies = {},
) {
  return execute(input, "dry_run", dependencies);
}

export function executeCommand(
  input: { commandId: string; session: Session; requestId: string; correlationId: string; abortSignal?: AbortSignal },
  dependencies: Dependencies = {},
) {
  return execute(input, "live", dependencies);
}

export function retryCommand(
  input: { commandId: string; session: Session; requestId: string; correlationId: string; abortSignal?: AbortSignal },
  dependencies: Dependencies = {},
) {
  return execute(input, "retry", dependencies);
}

export async function getCommandStatus(commandId: string, dependencies: Dependencies = {}) {
  const { repository } = await runtime(dependencies, false);
  const command = await repository.getCommand(commandId, true);
  if (!command) throw new HttpError(404, "SERVICENOW_WRITE_COMMAND_NOT_FOUND", "ServiceNow write command was not found");
  return command;
}

export async function listCommands(
  filters: Parameters<ServiceNowWriteRepository["listCommands"]>[0],
  dependencies: Dependencies = {},
) {
  const { repository } = await runtime(dependencies, false);
  return repository.listCommands(filters);
}

export function getServiceNowWriteReadiness(
  env: Record<string, string | undefined> = process.env,
): ServiceNowWriteReadiness {
  const relationalStorage = getDataBackend(env) === "supabase-relational";
  const summary = summarizeServiceNowConfig(env);
  let enabled = false;
  let incidentTable: string | undefined;
  let safeErrorCode: string | undefined;
  try {
    enabled = parseServiceNowWriteConfig(env).enabled;
    const config = parseServiceNowConfig(env);
    if (config.enabled) incidentTable = config.incidentTable;
  } catch {
    safeErrorCode = "SERVICENOW_CONFIGURATION_INVALID";
  }
  const configured = summary.configured && Boolean(incidentTable) && !safeErrorCode;
  return {
    configured,
    enabled,
    relationalStorage,
    ready: configured && enabled && relationalStorage,
    authMode: summary.authMode,
    hostname: summary.hostname,
    incidentTable,
    safeErrorCode: safeErrorCode || (!relationalStorage ? "SERVICENOW_WRITE_REQUIRES_RELATIONAL" : !enabled ? "SERVICENOW_WRITE_DISABLED" : !configured ? "SERVICENOW_CONFIGURATION_INVALID" : undefined),
    safeErrorMessage: !relationalStorage
      ? "Relational storage is required"
      : !enabled
        ? "Write execution is disabled"
        : !configured
          ? "ServiceNow configuration needs attention"
          : undefined,
  };
}

export async function testServiceNowWriteReadiness(
  input: { correlationId: string; abortSignal?: AbortSignal },
  dependencies: Dependencies = {},
) {
  const { adapter } = await runtime(dependencies, true);
  await adapter.testReadiness(correlationIdSchema.parse(input.correlationId), input.abortSignal);
  return { ...getServiceNowWriteReadiness(dependencies.env || process.env), connectionTested: true, ready: true };
}

export async function getServiceNowWriteOperationsSummary(dependencies: Dependencies = {}) {
  const env = dependencies.env || process.env;
  const readiness = getServiceNowWriteReadiness(env);
  if (!readiness.relationalStorage) {
    return { readiness, countsByStatus: {} };
  }
  const repository = dependencies.repository || new ServiceNowWriteRepository();
  return { readiness, ...await repository.getOperationsSummary() };
}
