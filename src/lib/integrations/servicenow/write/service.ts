import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { Session } from "../../../auth";
import { getDataBackend } from "../../../env";
import { writeAudit } from "../../../repositories";
import { HttpError } from "../../../request-security";
import { logServerCritical } from "../../../server-logging";
import { isIntegrationBoundaryError } from "../../errors";
import { correlationIdSchema } from "../../schemas";
import { parseServiceNowConfig, summarizeServiceNowConfig, type ServiceNowEnabledConfig } from "../config";
import { ServiceNowWriteAdapter } from "./adapter";
import { parseServiceNowWriteConfig } from "./config";
import {
  buildServiceNowWriteConfigurationFingerprint,
  buildServiceNowWriteCommandMaterialHash,
  buildServiceNowNormalizedPayloadHash,
  buildServiceNowProviderCorrelationMarker,
  buildServiceNowWriteIdempotencyKey,
  hashServiceNowWriteConfirmationNonce,
} from "./idempotency";
import {
  issueManualOperationIdentity,
  resolveManualOperationIdentity,
} from "./manual-operation";
import { serviceNowDefaultWriteMapping, validateServiceNowWriteFieldMapping, normalizeCommand } from "./normalization";
import { isServiceNowWriteExecutionError } from "./outcomes";
import { ServiceNowWriteRepository } from "./repository";
import {
  createServiceNowWriteCommandRequestSchema,
  serviceNowWriteConfirmationActionSchema,
} from "./schemas";
import type {
  ServiceNowWriteCommandInput,
  ServiceNowWriteCommandSummary,
  ServiceNowWriteConfirmation,
  ServiceNowWriteEvidenceClassification,
  ServiceNowManualOperationIdentity,
  ServiceNowWriteReadiness,
  ServiceNowWriteReconciliationAction,
  ServiceNowWriteReconciliationResult,
} from "./types";

type AuditWriter = typeof writeAudit;
type WriteAdapter = Pick<ServiceNowWriteAdapter, "preview" | "execute" | "readBack" | "testReadiness">;
type Dependencies = {
  env?: Record<string, string | undefined>;
  repository?: ServiceNowWriteRepository;
  adapter?: WriteAdapter;
  fetch?: typeof fetch;
  audit?: AuditWriter;
  now?: () => Date;
  createId?: () => string;
  createNonce?: () => string;
};

type ConfirmedAction = {
  confirmed: true;
  expectedVersion: number;
  expectedNormalizedPayloadHash: string;
  confirmationNonce: string;
};

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function runtimeConnectionId(config: ServiceNowEnabledConfig) {
  return `sn-write-${digest(`${config.instanceUrl}|${config.incidentTable}`).slice(0, 40)}`;
}

function credentialVersion(env: Record<string, string | undefined>) {
  const value = env.SERVICENOW_CREDENTIAL_VERSION?.trim() || "unversioned";
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(value)) {
    throw new HttpError(
      503,
      "SERVICENOW_CONFIGURATION_INVALID",
      "ServiceNow configuration is invalid",
    );
  }
  return value;
}

function configurationFingerprint(
  config: ServiceNowEnabledConfig,
  env: Record<string, string | undefined>,
) {
  return buildServiceNowWriteConfigurationFingerprint({
    instanceHostname: new URL(config.instanceUrl).host,
    incidentTable: config.incidentTable,
    authMode: config.authMode,
    credentialVersion: credentialVersion(env),
  });
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
  if (message.includes("SERVICENOW_WRITE_IDEMPOTENCY_CONFLICT")) throw new HttpError(409, "SERVICENOW_WRITE_IDEMPOTENCY_CONFLICT", "The operation is already associated with different command material");
  if (message.includes("SERVICENOW_WRITE_COMMAND_NOT_FOUND")) throw new HttpError(404, "SERVICENOW_WRITE_COMMAND_NOT_FOUND", "ServiceNow write command was not found");
  if (message.includes("SERVICENOW_WRITE_COMMAND_BUSY")) throw new HttpError(409, "SERVICENOW_WRITE_COMMAND_BUSY", "ServiceNow write command is already executing");
  if (message.includes("SERVICENOW_WRITE_ATTEMPTS_EXHAUSTED")) throw new HttpError(409, "SERVICENOW_WRITE_ATTEMPTS_EXHAUSTED", "ServiceNow write retry limit has been reached");
  if (message.includes("SERVICENOW_WRITE_SOURCE_NOT_FOUND")) throw new HttpError(409, "SERVICENOW_WRITE_SOURCE_NOT_FOUND", "The linked SUPPER source record was not found");
  if (message.includes("SERVICENOW_WRITE_CONFIRMATION")) throw new HttpError(409, "SERVICENOW_WRITE_CONFIRMATION_INVALID", "ServiceNow write confirmation is missing, stale, expired, or already used");
  if (message.includes("SERVICENOW_WRITE_READINESS_REQUIRED")) throw new HttpError(409, "SERVICENOW_WRITE_READINESS_REQUIRED", "A fresh successful ServiceNow readiness test is required");
  if (message.includes("SERVICENOW_WRITE_VERSION_CONFLICT")) throw new HttpError(409, "SERVICENOW_WRITE_VERSION_CONFLICT", "ServiceNow write command changed; review it again");
  if (message.includes("SERVICENOW_WRITE_RECONCILIATION_NOT_ALLOWED")) throw new HttpError(409, "SERVICENOW_WRITE_RECONCILIATION_NOT_ALLOWED", "ServiceNow write command does not require reconciliation");
  if (message.includes("SERVICENOW_WRITE_VERIFIED_TARGET_CONFLICT")) throw new HttpError(409, "SERVICENOW_WRITE_VERIFIED_TARGET_CONFLICT", "Verified target conflicts with the ServiceNow write command");
  if (message.includes("SERVICENOW_WRITE_MUTATION_CANDIDATE_CONFLICT")) throw new HttpError(409, "SERVICENOW_WRITE_MUTATION_CANDIDATE_CONFLICT", "Verified target conflicts with the recorded ServiceNow mutation candidate");
  if (message.includes("SERVICENOW_WRITE_RECONCILIATION_EVIDENCE_INVALID")) throw new HttpError(409, "SERVICENOW_WRITE_RECONCILIATION_EVIDENCE_INVALID", "ServiceNow write reconciliation evidence does not support this decision");
  if (message.includes("SERVICENOW_WRITE_RECONCILIATION_INVALID")) throw new HttpError(400, "SERVICENOW_WRITE_RECONCILIATION_INVALID", "ServiceNow write reconciliation evidence is invalid");
  if (message.includes("SERVICENOW_WRITE_DRY_RUN_NOT_ALLOWED")
    || message.includes("SERVICENOW_WRITE_EXECUTION_NOT_ALLOWED")
    || message.includes("SERVICENOW_WRITE_RETRY_NOT_ALLOWED")) {
    throw new HttpError(409, "SERVICENOW_WRITE_TRANSITION_NOT_ALLOWED", "ServiceNow write command cannot perform this transition");
  }
  if (message.includes("SERVICENOW_WRITE_CONNECTION_UNAVAILABLE")) throw new HttpError(503, "SERVICENOW_WRITE_CONNECTION_UNAVAILABLE", "ServiceNow write connection is unavailable");
  if (message.includes("SERVICENOW_WRITE_MAPPING_UNAVAILABLE")) throw new HttpError(409, "SERVICENOW_WRITE_MAPPING_UNAVAILABLE", "ServiceNow write mapping is unavailable");
  if (message.includes("SERVICENOW_WRITE_STORAGE_INTEGRITY_ERROR")) throw new HttpError(500, "SERVICENOW_WRITE_STORAGE_INTEGRITY_ERROR", "Stored ServiceNow write data failed integrity validation");
  throw error;
}

async function auditBestEffort(
  command: ServiceNowWriteCommandSummary,
  session: Session,
  event: "created" | "dry_run" | "executed" | "retried" | "reconciled",
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
        sourceEntityReference: command.sourceEntityReference || null,
        operationReference: command.operationReference,
        attemptCount: command.attemptCount,
        targetNumber: command.targetNumber || null,
        deliveryDisposition: command.deliveryDisposition || null,
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

async function ledgerRuntime(dependencies: Dependencies) {
  const env = dependencies.env || process.env;
  requireRelational(env);
  const repository = dependencies.repository || new ServiceNowWriteRepository();
  return { env, repository };
}

async function providerRuntime(dependencies: Dependencies, requireWriteEnabled: boolean) {
  const { env, repository } = await ledgerRuntime(dependencies);
  const config = requireServiceNowConfig(env);
  const writeConfig = parseServiceNowWriteConfig(env);
  if (requireWriteEnabled && !writeConfig.enabled) {
    throw new HttpError(503, "SERVICENOW_WRITE_DISABLED", "ServiceNow write execution is disabled");
  }
  const adapter = dependencies.adapter || new ServiceNowWriteAdapter(config, { fetch: dependencies.fetch || fetch });
  return { env, config, writeConfig, repository, adapter };
}

async function optionalProviderRuntime(dependencies: Dependencies) {
  try {
    return {
      available: true as const,
      ...await providerRuntime(dependencies, false),
    };
  } catch (error) {
    if (!(error instanceof HttpError)
      || !["SERVICENOW_DISABLED", "SERVICENOW_CONFIGURATION_INVALID"].includes(error.code)) {
      throw error;
    }
    return {
      available: false as const,
      ...await ledgerRuntime(dependencies),
      providerErrorCode: error.code,
    };
  }
}

export function validateCommand(input: unknown): ServiceNowWriteCommandInput {
  return createServiceNowWriteCommandRequestSchema.parse(input);
}

export async function issueManualOperation(
  input: {
    commandType: ServiceNowWriteCommandInput["commandType"];
    sourceType: "manual";
    sourceEntityReference?: string;
    session: Session;
  },
  dependencies: Dependencies = {},
): Promise<ServiceNowManualOperationIdentity> {
  await ledgerRuntime(dependencies);
  return issueManualOperationIdentity({
    session: input.session,
    commandType: input.commandType,
    sourceEntityReference: input.sourceEntityReference,
  }, {
    env: dependencies.env || process.env,
    now: dependencies.now,
  });
}

export async function createCommand(
  input: ServiceNowWriteCommandInput & { session: Session; requestId: string; correlationId: string },
  dependencies: Dependencies = {},
) {
  const { session, requestId, correlationId, ...commandInput } = input;
  const validated = validateCommand(commandInput);
  const { env, config, writeConfig, repository } = await providerRuntime(dependencies, false);
  const createId = dependencies.createId || (() => crypto.randomUUID());
  const commandId = createId();
  const operationReference = validated.sourceType === "manual"
    ? (await resolveManualOperationIdentity({
      operationToken: validated.manualOperationToken || "",
      session,
      commandType: validated.commandType,
      sourceEntityReference: validated.sourceEntityReference,
    }, {
      env,
      now: dependencies.now,
    })).operationReference
    : validated.operationReference!;
  const connectionId = runtimeConnectionId(config);
  await repository.ensureConnection(
    connectionId,
    config,
    configurationFingerprint(config, env),
    credentialVersion(env),
  );
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
  const identityInput = {
    commandType: validated.commandType,
    sourceType: validated.sourceType,
    sourceEntityReference: validated.sourceEntityReference,
    operationReference,
  };
  const idempotencyKey = buildServiceNowWriteIdempotencyKey(identityInput, connectionId, config.incidentTable);
  const providerCorrelationMarker = validated.commandType === "create_incident"
    ? buildServiceNowProviderCorrelationMarker(idempotencyKey)
    : undefined;
  const normalized = normalizeCommand(validated, safeMapping, providerCorrelationMarker);
  const normalizedPayloadHash = buildServiceNowNormalizedPayloadHash(normalized);
  const maxAttempts = Math.min(
    validated.maxAttempts || writeConfig.maxAttempts,
    writeConfig.maxAttempts,
  );
  const commandMaterialHash = buildServiceNowWriteCommandMaterialHash({
    commandType: validated.commandType,
    sourceType: validated.sourceType,
    sourceEntityReference: validated.sourceEntityReference,
    operationReference,
    payload: validated.payload,
    maxAttempts,
  }, connectionId, mapping.id, config.incidentTable);
  const now = (dependencies.now || (() => new Date()))().toISOString();
  try {
    const result = await repository.createCommand({
      commandId,
      commandType: validated.commandType,
      idempotencyKey,
      commandMaterialHash,
      normalizedPayloadHash,
      connectionId,
      mappingId: mapping.id,
      sourceType: validated.sourceType,
      sourceEntityReference: validated.sourceEntityReference || "",
      operationReference,
      targetTable: config.incidentTable,
      targetSysId: normalized.targetSysId || "",
      targetNumber: normalized.targetNumber || "",
      providerCorrelationMarker: providerCorrelationMarker || "",
      payload: validated.payload,
      normalizedPayload: normalized,
      validationSummary: {
        valid: true,
        mappedFieldCount: Object.keys(normalized.fields).length,
        mappedFields: Object.keys(normalized.fields).sort(),
        warningCodes: [],
      },
      maxAttempts,
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

async function requireFreshReadinessProof(
  commandId: string,
  repository: ServiceNowWriteRepository,
  config: ServiceNowEnabledConfig,
  env: Record<string, string | undefined>,
  at: Date,
) {
  const context = await repository.getCommandExecutionContext(commandId);
  if (!context) {
    throw new HttpError(404, "SERVICENOW_WRITE_COMMAND_NOT_FOUND", "ServiceNow write command was not found");
  }
  const connectionId = runtimeConnectionId(config);
  if (context.connection_id !== connectionId) {
    throw new HttpError(409, "SERVICENOW_WRITE_READINESS_REQUIRED", "The command connection no longer matches the active configuration");
  }
  const proof = await repository.getReadinessProof(connectionId);
  const readiness = getServiceNowWriteReadiness(env, proof, at);
  if (!readiness.liveWriteReady) {
    throw new HttpError(409, "SERVICENOW_WRITE_READINESS_REQUIRED", "A fresh successful ServiceNow readiness test is required");
  }
}

async function execute(
  input: {
    commandId: string;
    session: Session;
    requestId: string;
    correlationId: string;
    confirmation?: ConfirmedAction;
    abortSignal?: AbortSignal;
  },
  mode: "dry_run" | "live" | "retry",
  dependencies: Dependencies,
) {
  const live = mode !== "dry_run";
  const { env, config, repository, adapter } = await providerRuntime(dependencies, live);
  const now = dependencies.now || (() => new Date());
  if (live) {
    await requireFreshReadinessProof(
      input.commandId,
      repository,
      config,
      env,
      now(),
    );
  }
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
      actorUserId: input.session.userId,
      ...(input.confirmation ? {
        confirmed: input.confirmation.confirmed,
        expectedVersion: input.confirmation.expectedVersion,
        expectedNormalizedPayloadHash: input.confirmation.expectedNormalizedPayloadHash,
        confirmationNonceHash: hashServiceNowWriteConfirmationNonce(input.confirmation.confirmationNonce),
      } : {}),
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
        deliveryDisposition: "definitely_not_sent",
        failurePhase: "",
        retryAllowed: false,
        retryReason: "",
        reconciliationReason: "",
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
      deliveryDisposition: "confirmed_succeeded",
      failurePhase: "",
      retryAllowed: false,
      retryReason: "",
      reconciliationReason: "",
      requestSummary: result.requestSummary,
      responseSummary: result.responseSummary,
      targetSysId: result.targetSysId,
      targetNumber: result.targetNumber,
      ...(result.mutationCandidate ? {
        mutationCandidateSysId: result.mutationCandidate.sysId,
        mutationCandidateNumber: result.mutationCandidate.number,
        mutationCandidateHttpStatus: result.mutationCandidate.httpStatus,
        mutationCandidateSource: result.mutationCandidate.source,
      } : {}),
      errorCode: "",
      errorMessage: "",
      finishedAt: now().toISOString(),
    });
  } catch (error) {
    const finishedAt = now();
    const classified = isServiceNowWriteExecutionError(error);
    const uncertain = !classified || error.deliveryDisposition === "may_have_committed";
    const retryAllowed = classified && error.retryAllowed && !uncertain;
    const deliveryDisposition = classified ? error.deliveryDisposition : "may_have_committed";
    const failurePhase = classified ? error.failurePhase : "mutation_dispatch";
    const safeErrorCode = isIntegrationBoundaryError(error) ? error.code : "SERVICENOW_WRITE_EXECUTION_UNCERTAIN";
    const safeErrorMessage = isIntegrationBoundaryError(error)
      ? error.safeMessage
      : "ServiceNow mutation outcome requires reconciliation";
    const reconciliationReason = classified
      ? error.reconciliationReason || (uncertain ? "Mutation outcome is not definitive" : "")
      : "Mutation execution ended without a classified provider outcome";
    if (uncertain) {
      logServerCritical("SERVICENOW_WRITE_EXECUTION_STATE_UNCERTAIN", error, {
        requestId: input.requestId,
        operation: "servicenow.write.execute",
        commandId: input.commandId,
        attemptId,
        failurePhase,
      });
    }
    try {
      await repository.finishAttempt({
        commandId: input.commandId,
        attemptId,
        outcome: uncertain ? "uncertain" : "failed",
        deliveryDisposition,
        failurePhase,
        retryAllowed,
        retryReason: retryAllowed ? "Provider definitively allowed a bounded retry" : "",
        reconciliationReason,
        requestSummary,
        responseSummary: classified ? error.safeResponseSummary || {} : {},
        targetSysId: normalized.targetSysId || "",
        targetNumber: normalized.targetNumber || "",
        ...(classified
          && error.mutationCandidateSysId
          && error.mutationCandidateNumber
          && error.mutationHttpStatus !== undefined ? {
            mutationCandidateSysId: error.mutationCandidateSysId,
            mutationCandidateNumber: error.mutationCandidateNumber,
            mutationCandidateHttpStatus: error.mutationHttpStatus,
            mutationCandidateSource: "mutation_response",
          } : {}),
        errorCode: safeErrorCode,
        errorMessage: safeErrorMessage,
        ...(retryAllowed ? {
          nextRetryAt: new Date(finishedAt.getTime() + retryDelayMilliseconds(started.live_attempt_count)).toISOString(),
        } : {}),
        finishedAt: finishedAt.toISOString(),
      });
    } catch (storageError) {
      logServerCritical("SERVICENOW_WRITE_FAILURE_PERSISTENCE_FAILED", storageError, {
        requestId: input.requestId,
        operation: "servicenow.write.execute",
        commandId: input.commandId,
        attemptId,
        providerErrorCode: safeErrorCode,
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
  input: { commandId: string; session: Session; requestId: string; correlationId: string; confirmation: ConfirmedAction; abortSignal?: AbortSignal },
  dependencies: Dependencies = {},
) {
  return execute(input, "live", dependencies);
}

export function retryCommand(
  input: { commandId: string; session: Session; requestId: string; correlationId: string; confirmation: ConfirmedAction; abortSignal?: AbortSignal },
  dependencies: Dependencies = {},
) {
  return execute(input, "retry", dependencies);
}

export async function issueCommandConfirmation(
  input: {
    commandId: string;
    action: ServiceNowWriteConfirmation["action"];
    expectedVersion: number;
    expectedNormalizedPayloadHash: string;
    session: Session;
  },
  dependencies: Dependencies = {},
): Promise<ServiceNowWriteConfirmation> {
  const { repository } = await ledgerRuntime(dependencies);
  const action = serviceNowWriteConfirmationActionSchema.parse(input.action);
  const nonce = (dependencies.createNonce || (() => randomBytes(32).toString("base64url")))();
  const issuedAt = (dependencies.now || (() => new Date()))();
  const expiresAt = new Date(issuedAt.getTime() + 2 * 60_000).toISOString();
  try {
    const stored = await repository.issueConfirmation({
      commandId: input.commandId,
      action,
      actorUserId: input.session.userId,
      expectedVersion: input.expectedVersion,
      expectedNormalizedPayloadHash: input.expectedNormalizedPayloadHash,
      confirmationNonceHash: hashServiceNowWriteConfirmationNonce(nonce),
      expiresAt,
      issuedAt: issuedAt.toISOString(),
    });
    return {
      confirmationNonce: nonce,
      action,
      commandId: stored.command_id,
      expectedVersion: stored.command_version,
      expectedNormalizedPayloadHash: stored.normalized_payload_hash,
      expiresAt: stored.confirmation_expires_at,
    };
  } catch (error) {
    operationalError(error);
  }
}

export async function reconcileCommand(
  input: {
    commandId: string;
    action: ServiceNowWriteReconciliationAction;
    session: Session;
    requestId: string;
    correlationId: string;
    confirmation: ConfirmedAction;
    verifiedTargetSysId?: string;
    verifiedTargetNumber?: string;
    verificationAcknowledged?: true;
    duplicateJournalRiskAcknowledged?: true;
    mutationCandidateRiskAcknowledged?: true;
    verificationNote?: string;
    abortSignal?: AbortSignal;
  },
  dependencies: Dependencies = {},
) {
  const { repository } = await ledgerRuntime(dependencies);
  const normalized = await repository.getNormalizedCommand(input.commandId);
  if (!normalized) throw new HttpError(404, "SERVICENOW_WRITE_COMMAND_NOT_FOUND", "ServiceNow write command was not found");
  const mutationCandidate = typeof repository.getMutationCandidate === "function"
    ? await repository.getMutationCandidate(input.commandId)
    : undefined;
  const checkedAt = (dependencies.now || (() => new Date()))().toISOString();
  let reconciliationResult: ServiceNowWriteReconciliationResult = input.action === "mark_succeeded_after_verification"
    ? "confirmed_succeeded"
    : input.action === "mark_not_applied_after_verification"
      ? "confirmed_not_applied"
      : "inconclusive";
  let evidenceClassification: ServiceNowWriteEvidenceClassification = "provider_inconclusive";
  let safeReadBackSummary: Record<string, unknown> = {
    method: input.action === "reconcile_by_read_back" ? "provider_read_back" : "manual_verification",
  };
  let targetSysId = input.verifiedTargetSysId || "";
  let targetNumber = input.verifiedTargetNumber || "";
  if (input.action === "reconcile_by_read_back") {
    const provider = await optionalProviderRuntime(dependencies);
    if (!provider.available) {
      reconciliationResult = "read_back_failed";
      evidenceClassification = "provider_unavailable";
      safeReadBackSummary = {
        method: "provider_read_back",
        result: "failed",
        evidenceClassification,
        errorCode: provider.providerErrorCode,
      };
    } else {
      try {
        const readBack = await provider.adapter.readBack(
          normalized,
          correlationIdSchema.parse(input.correlationId),
          input.abortSignal,
        );
        reconciliationResult = readBack.result;
        evidenceClassification = readBack.result === "confirmed_succeeded"
          ? "provider_matched"
          : readBack.result === "not_found"
            ? "provider_not_found"
            : readBack.result === "ambiguous"
              ? "provider_ambiguous"
              : "provider_inconclusive";
        const resultHasTarget = readBack.result === "confirmed_succeeded"
          || readBack.result === "inconclusive";
        const candidateConflict = resultHasTarget
          && mutationCandidate
          && (readBack.targetSysId !== mutationCandidate.sysId
            || readBack.targetNumber !== mutationCandidate.number);
        if (resultHasTarget && (!readBack.targetSysId || !readBack.targetNumber)) {
          reconciliationResult = "read_back_failed";
          evidenceClassification = "provider_target_conflict";
          safeReadBackSummary = {
            method: "provider_read_back",
            result: "failed",
            evidenceClassification,
            errorCode: "SERVICENOW_WRITE_PROVIDER_PROOF_REQUIRED",
          };
        } else if (candidateConflict) {
          reconciliationResult = "read_back_failed";
          evidenceClassification = "provider_target_conflict";
          safeReadBackSummary = {
            method: "provider_read_back",
            result: "failed",
            evidenceClassification,
            errorCode: "SERVICENOW_WRITE_MUTATION_CANDIDATE_CONFLICT",
            mutationCandidateMatched: false,
          };
        } else {
          safeReadBackSummary = {
            ...readBack.summary,
            evidenceClassification,
            ...((readBack.result === "confirmed_succeeded" || readBack.result === "inconclusive")
              ? {
                targetSysId: readBack.targetSysId,
                targetNumber: readBack.targetNumber,
                ...(mutationCandidate ? { mutationCandidateMatched: true } : {}),
              }
              : {}),
          };
          if (readBack.result === "confirmed_succeeded" || readBack.result === "inconclusive") {
            targetSysId = readBack.targetSysId || "";
            targetNumber = readBack.targetNumber || "";
          }
        }
      } catch (error) {
        const lookupMismatch = isIntegrationBoundaryError(error)
          && error.code === "SERVICENOW_WRITE_LOOKUP_MISMATCH";
        reconciliationResult = "read_back_failed";
        evidenceClassification = lookupMismatch
          ? "provider_target_conflict"
          : "provider_unavailable";
        safeReadBackSummary = {
          method: "provider_read_back",
          result: "failed",
          evidenceClassification,
          errorCode: isIntegrationBoundaryError(error) ? error.code : "SERVICENOW_READ_BACK_FAILED",
        };
      }
    }
  } else if (input.action === "mark_succeeded_after_verification") {
    if (!input.verificationAcknowledged || !input.verificationNote || !targetSysId || !targetNumber) {
      throw new HttpError(400, "SERVICENOW_WRITE_VERIFIED_TARGET_REQUIRED", "Verified ServiceNow sys_id and number are required");
    }
    if ((normalized.targetSysId && normalized.targetSysId !== targetSysId)
      || (normalized.targetNumber && normalized.targetNumber !== targetNumber)) {
      throw new HttpError(409, "SERVICENOW_WRITE_VERIFIED_TARGET_CONFLICT", "Verified target conflicts with the original command target");
    }
    if (mutationCandidate
      && (mutationCandidate.sysId !== targetSysId || mutationCandidate.number !== targetNumber)) {
      throw new HttpError(
        409,
        "SERVICENOW_WRITE_MUTATION_CANDIDATE_CONFLICT",
        "Verified target conflicts with the recorded ServiceNow mutation candidate",
      );
    }
    evidenceClassification = "provider_unavailable_manual_verification";
    let providerResult = "provider_configuration_unavailable";
    const provider = await optionalProviderRuntime(dependencies);
    if (provider.available) {
      try {
        const readBack = await provider.adapter.readBack(
          normalized,
          correlationIdSchema.parse(input.correlationId),
          input.abortSignal,
        );
        providerResult = readBack.result;
        if (readBack.result === "not_found") {
          throw new HttpError(409, "SERVICENOW_WRITE_PROVIDER_NOT_FOUND", "Provider read-back did not find the verified Incident");
        }
        if (readBack.result === "ambiguous") {
          throw new HttpError(409, "SERVICENOW_WRITE_RECONCILIATION_AMBIGUOUS", "Provider read-back matched multiple Incidents");
        }
        if (!readBack.targetSysId || !readBack.targetNumber) {
          throw new HttpError(409, "SERVICENOW_WRITE_PROVIDER_PROOF_REQUIRED", "Provider read-back did not return one exact Incident identity");
        }
        if (readBack.targetSysId !== targetSysId || readBack.targetNumber !== targetNumber) {
          throw new HttpError(
            409,
            mutationCandidate
              ? "SERVICENOW_WRITE_MUTATION_CANDIDATE_CONFLICT"
              : "SERVICENOW_WRITE_VERIFIED_TARGET_CONFLICT",
            mutationCandidate
              ? "Provider read-back conflicts with the recorded ServiceNow mutation candidate"
              : "Verified target conflicts with provider read-back",
          );
        }
        evidenceClassification = readBack.result === "confirmed_succeeded"
          ? "provider_matched"
          : "provider_target_matched_manual_verification";
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (isIntegrationBoundaryError(error)
          && error.code === "SERVICENOW_WRITE_LOOKUP_MISMATCH") {
          throw new HttpError(
            409,
            mutationCandidate
              ? "SERVICENOW_WRITE_MUTATION_CANDIDATE_CONFLICT"
              : "SERVICENOW_WRITE_VERIFIED_TARGET_CONFLICT",
            mutationCandidate
              ? "Provider read-back conflicts with the recorded ServiceNow mutation candidate"
              : "Provider read-back returned a conflicting Incident identity",
          );
        }
        if (!isIntegrationBoundaryError(error)
          || !["unavailable", "timeout"].includes(error.category)) {
          throw error;
        }
        providerResult = "provider_unavailable";
      }
    } else {
      providerResult = provider.providerErrorCode;
    }
    if (evidenceClassification === "provider_unavailable_manual_verification" && !mutationCandidate) {
      throw new HttpError(
        409,
        "SERVICENOW_WRITE_MUTATION_CANDIDATE_CONFLICT",
        "Provider-unavailable manual success requires a recorded ServiceNow mutation candidate",
      );
    }
    safeReadBackSummary = {
      method: "manual_verified_target",
      targetSysId,
      targetNumber,
      verificationAcknowledged: true,
      verificationEvidenceProvided: true,
      evidenceClassification,
      providerResult,
      ...(mutationCandidate ? { mutationCandidateMatched: true } : {}),
    };
  } else {
    if (!input.verificationAcknowledged || !input.verificationNote) {
      throw new HttpError(400, "SERVICENOW_WRITE_VERIFICATION_REQUIRED", "Explicit verification evidence is required");
    }
    let providerResult = "manual_override";
    if (normalized.commandType === "add_comment" || normalized.commandType === "add_work_note") {
      if (!input.duplicateJournalRiskAcknowledged) {
        throw new HttpError(
          400,
          "SERVICENOW_WRITE_DUPLICATE_JOURNAL_ACK_REQUIRED",
          "Explicit duplicate-journal-risk acknowledgment is required",
        );
      }
      evidenceClassification = "journal_manual_verification";
      providerResult = "journal_presence_not_safely_provable";
    } else {
      if (normalized.commandType === "create_incident"
        && mutationCandidate
        && !input.mutationCandidateRiskAcknowledged) {
        throw new HttpError(
          400,
          "SERVICENOW_WRITE_MUTATION_CANDIDATE_RISK_ACK_REQUIRED",
          "Explicit mutation-candidate duplicate-risk acknowledgment is required",
        );
      }
      evidenceClassification = "provider_unavailable_manual_verification";
      const provider = await optionalProviderRuntime(dependencies);
      if (provider.available) {
        try {
          const readBack = await provider.adapter.readBack(
            normalized,
            correlationIdSchema.parse(input.correlationId),
            input.abortSignal,
          );
          providerResult = readBack.result;
          if (readBack.result === "confirmed_succeeded") {
            throw new HttpError(409, "SERVICENOW_WRITE_PROVIDER_MATCHED", "Provider read-back confirms the reviewed mutation is present");
          }
          if (readBack.result === "ambiguous") {
            throw new HttpError(409, "SERVICENOW_WRITE_RECONCILIATION_AMBIGUOUS", "Provider read-back matched multiple Incidents");
          }
          if (readBack.result === "inconclusive") {
            throw new HttpError(
              409,
              "SERVICENOW_WRITE_PROVIDER_INCONCLUSIVE",
              "Provider read-back could not prove the reviewed mutation was not applied",
            );
          }
          evidenceClassification = "provider_not_found";
        } catch (error) {
          if (error instanceof HttpError) throw error;
          if (isIntegrationBoundaryError(error)
            && error.code === "SERVICENOW_WRITE_LOOKUP_MISMATCH") {
            throw new HttpError(409, "SERVICENOW_WRITE_VERIFIED_TARGET_CONFLICT", "Provider read-back returned a conflicting Incident identity");
          }
          if (!isIntegrationBoundaryError(error)
            || !["unavailable", "timeout"].includes(error.category)) {
            throw error;
          }
          providerResult = "provider_unavailable";
        }
      } else {
        providerResult = provider.providerErrorCode;
      }
    }
    safeReadBackSummary = {
      method: "manual_verified_not_applied",
      verificationAcknowledged: true,
      verificationEvidenceProvided: true,
      evidenceClassification,
      providerResult,
      ...(normalized.commandType === "add_comment" || normalized.commandType === "add_work_note"
        ? { duplicateJournalRiskAcknowledged: input.duplicateJournalRiskAcknowledged }
        : mutationCandidate
          ? { mutationCandidateRiskAcknowledged: input.mutationCandidateRiskAcknowledged }
          : {}),
    };
  }
  try {
    await repository.reconcile({
      commandId: input.commandId,
      action: input.action,
      result: reconciliationResult,
      safeReadBackSummary,
      targetSysId,
      targetNumber,
      ...(input.action === "reconcile_by_read_back" ? {} : {
        verificationAcknowledged: input.verificationAcknowledged,
        ...(input.duplicateJournalRiskAcknowledged
          ? { duplicateJournalRiskAcknowledged: input.duplicateJournalRiskAcknowledged }
          : {}),
        ...(input.mutationCandidateRiskAcknowledged
          ? { mutationCandidateRiskAcknowledged: input.mutationCandidateRiskAcknowledged }
          : {}),
        verificationNote: input.verificationNote,
      }),
      actorUserId: input.session.userId,
      requestId: input.requestId,
      checkedAt,
      confirmed: input.confirmation.confirmed,
      expectedVersion: input.confirmation.expectedVersion,
      expectedNormalizedPayloadHash: input.confirmation.expectedNormalizedPayloadHash,
      confirmationNonceHash: hashServiceNowWriteConfirmationNonce(input.confirmation.confirmationNonce),
    });
    const command = await repository.getCommand(input.commandId, true);
    if (!command) throw new Error("ServiceNow write command disappeared after reconciliation");
    return auditBestEffort(command, input.session, "reconciled", input.requestId, dependencies.audit || writeAudit);
  } catch (error) {
    operationalError(error);
  }
}

export async function getCommandStatus(commandId: string, dependencies: Dependencies = {}) {
  const { repository } = await ledgerRuntime(dependencies);
  const command = await repository.getCommand(commandId, true);
  if (!command) throw new HttpError(404, "SERVICENOW_WRITE_COMMAND_NOT_FOUND", "ServiceNow write command was not found");
  return command;
}

export async function listCommands(
  filters: Parameters<ServiceNowWriteRepository["listCommands"]>[0],
  dependencies: Dependencies = {},
) {
  const { repository } = await ledgerRuntime(dependencies);
  return repository.listCommands(filters);
}

export function getServiceNowWriteReadiness(
  env: Record<string, string | undefined> = process.env,
  proof?: Awaited<ReturnType<ServiceNowWriteRepository["getReadinessProof"]>>,
  at = new Date(),
): ServiceNowWriteReadiness {
  const relationalStorage = getDataBackend(env) === "supabase-relational";
  const summary = summarizeServiceNowConfig(env);
  let liveWriteEnabled = false;
  let incidentTable: string | undefined;
  let safeErrorCode: string | undefined;
  let enabledConfig: ServiceNowEnabledConfig | undefined;
  try {
    liveWriteEnabled = parseServiceNowWriteConfig(env).enabled;
    const config = parseServiceNowConfig(env);
    if (config.enabled) {
      credentialVersion(env);
      incidentTable = config.incidentTable;
      enabledConfig = config;
    }
  } catch {
    safeErrorCode = "SERVICENOW_CONFIGURATION_INVALID";
  }
  const configured = summary.configured && Boolean(incidentTable) && !safeErrorCode;
  const connectionTestable = configured && relationalStorage;
  const fingerprint = configured && enabledConfig
    ? configurationFingerprint(enabledConfig, env)
    : undefined;
  const proofMatches = Boolean(proof && fingerprint && proof.configuration_fingerprint === fingerprint);
  const proofFresh = Boolean(proofMatches
    && proof?.test_status === "succeeded"
    && new Date(proof.expires_at).getTime() > at.getTime());
  const connectionTestExpired = Boolean(proofMatches
    && proof?.test_status === "succeeded"
    && !proofFresh);
  return {
    configured,
    relationalStorage,
    connectionTestable,
    connectionTested: proofFresh,
    connectionTestExpired,
    liveWriteEnabled,
    liveWriteReady: connectionTestable && liveWriteEnabled && proofFresh,
    configurationFingerprint: fingerprint,
    testedAt: proofMatches ? proof?.tested_at : undefined,
    proofExpiresAt: proofMatches ? proof?.expires_at : undefined,
    testStatus: proofMatches ? proof?.test_status : undefined,
    safeHttpStatus: proofMatches ? proof?.safe_http_status || undefined : undefined,
    authMode: summary.authMode,
    hostname: summary.hostname,
    incidentTable,
    safeErrorCode: safeErrorCode
      || (!relationalStorage
        ? "SERVICENOW_WRITE_REQUIRES_RELATIONAL"
        : !configured
          ? "SERVICENOW_CONFIGURATION_INVALID"
          : !proofMatches
            ? "SERVICENOW_WRITE_CONNECTION_UNTESTED"
            : connectionTestExpired
              ? "SERVICENOW_WRITE_READINESS_EXPIRED"
              : proof?.test_status === "failed"
                ? proof.safe_error_code || "SERVICENOW_WRITE_READINESS_FAILED"
                : !liveWriteEnabled
            ? "SERVICENOW_WRITE_DISABLED"
            : undefined),
    safeErrorMessage: !relationalStorage
      ? "Relational storage is required"
      : !configured
        ? "ServiceNow configuration needs attention"
        : !proofMatches
          ? "Connection is configured but has not been tested"
          : connectionTestExpired
            ? "The successful connection test has expired"
            : proof?.test_status === "failed"
              ? "The latest connection test failed"
              : !liveWriteEnabled
          ? "Connection testing is available; live mutation remains disabled"
          : undefined,
  };
}

export async function testServiceNowWriteReadiness(
  input: { correlationId: string; session: Session; abortSignal?: AbortSignal },
  dependencies: Dependencies = {},
) {
  const { env, config, adapter, repository } = await providerRuntime(dependencies, false);
  const now = dependencies.now || (() => new Date());
  const testedAt = now();
  const fingerprint = configurationFingerprint(config, env);
  const connectionId = runtimeConnectionId(config);
  await repository.ensureConnection(
    connectionId,
    config,
    fingerprint,
    credentialVersion(env),
  );
  try {
    const result = await adapter.testReadiness(
      correlationIdSchema.parse(input.correlationId),
      input.abortSignal,
    );
    const expiresAt = new Date(testedAt.getTime() + 5 * 60_000);
    const proof = await repository.recordReadinessProof({
      connectionId,
      configurationFingerprint: fingerprint,
      testedAt: testedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      testStatus: "succeeded",
      safeHttpStatus: result.httpStatus,
      testedByUserId: input.session.userId,
      safeErrorCode: "",
      updatedAt: testedAt.toISOString(),
    });
    return getServiceNowWriteReadiness(env, {
      ...proof,
      tested_by_user_id: input.session.userId,
      updated_at: testedAt.toISOString(),
    }, testedAt);
  } catch (error) {
    const safeErrorCode = isIntegrationBoundaryError(error)
      ? error.code
      : "SERVICENOW_WRITE_READINESS_FAILED";
    await repository.recordReadinessProof({
      connectionId,
      configurationFingerprint: fingerprint,
      testedAt: testedAt.toISOString(),
      expiresAt: testedAt.toISOString(),
      testStatus: "failed",
      safeHttpStatus: null,
      testedByUserId: input.session.userId,
      safeErrorCode,
      updatedAt: testedAt.toISOString(),
    });
    throw error;
  }
}

export async function getServiceNowWriteOperationsSummary(dependencies: Dependencies = {}) {
  const env = dependencies.env || process.env;
  const baseReadiness = getServiceNowWriteReadiness(env);
  if (!baseReadiness.relationalStorage) {
    return { readiness: baseReadiness, countsByStatus: {} };
  }
  const repository = dependencies.repository || new ServiceNowWriteRepository();
  let proof;
  if (baseReadiness.configured) {
    const config = requireServiceNowConfig(env);
    proof = await repository.getReadinessProof(runtimeConnectionId(config));
  }
  const readiness = getServiceNowWriteReadiness(env, proof);
  return { readiness, ...await repository.getOperationsSummary() };
}
