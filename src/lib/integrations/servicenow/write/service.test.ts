import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { Session } from "../../../auth";
import type { Audit } from "../../../types";
import { correlationIdSchema } from "../../schemas";
import { serviceNowError } from "../errors";
import { buildServiceNowWriteConfigurationFingerprint } from "./idempotency";
import { issueManualOperationIdentity } from "./manual-operation";
import { serviceNowDefaultWriteMapping } from "./normalization";
import { serviceNowWriteExecutionError } from "./outcomes";
import type { ServiceNowWriteRepository } from "./repository";
import {
  createCommand,
  executeCommand,
  executeCommandDryRun,
  getCommandStatus,
  issueCommandConfirmation,
  issueManualOperation,
  getServiceNowWriteReadiness,
  getServiceNowWriteOperationsSummary,
  listCommands,
  reconcileCommand,
  recoverStuckAttempt,
  retryCommand,
  testServiceNowWriteReadiness,
} from "./service";
import type {
  NormalizedServiceNowWriteCommand,
  ServiceNowWriteCommandSummary,
} from "./types";

const session: Session = {
  userId: "admin-id",
  username: "admin",
  name: "Admin",
  role: "admin",
  authVersion: 1,
};
const env = {
  DATA_BACKEND: "supabase-relational",
  SERVICENOW_ENABLED: "true",
  SERVICENOW_WRITE_ENABLED: "true",
  SERVICENOW_WRITE_MAX_ATTEMPTS: "3",
  SERVICENOW_AUTH_MODE: "basic",
  SERVICENOW_INSTANCE_URL: "https://example.service-now.com",
  SERVICENOW_USERNAME: "unit-test-user",
  SERVICENOW_PASSWORD: "unit-test-placeholder",
  SERVICENOW_INCIDENT_TABLE: "incident",
  SERVICENOW_TIMEOUT_MS: "5000",
  SERVICENOW_PAGE_SIZE: "25",
};
const hash = "a".repeat(64);
const marker = `SUPPER:${"b".repeat(64)}`;
const configurationFingerprint = buildServiceNowWriteConfigurationFingerprint({
  instanceHostname: "example.service-now.com",
  incidentTable: "incident",
  authMode: "basic",
  credentialVersion: "unversioned",
});
const connectionId = `sn-write-${createHash("sha256")
  .update("https://example.service-now.com|incident", "utf8")
  .digest("hex")
  .slice(0, 40)}`;
const confirmation = {
  confirmed: true as const,
  expectedVersion: 1,
  expectedNormalizedPayloadHash: hash,
  confirmationNonce: "nonce-value-with-sufficient-entropy",
};
const normalizedCreate: NormalizedServiceNowWriteCommand = {
  schemaVersion: "servicenow-write-normalized-v2",
  commandType: "create_incident",
  providerCorrelationMarker: marker,
  fields: { correlation_id: marker, short_description: "Short", description: "Description" },
};
const normalizedUpdate: NormalizedServiceNowWriteCommand = {
  schemaVersion: "servicenow-write-normalized-v2",
  commandType: "update_incident",
  targetSysId: "b".repeat(32),
  fields: { state: "2" },
};
const mutationCandidate = {
  sysId: "b".repeat(32),
  number: "INC0010004",
  httpStatus: 201,
  observedAt: "2026-07-23T01:04:00.000Z",
  source: "mutation_response" as const,
};
const ledgerMutationCandidate = {
  ...mutationCandidate,
  id: `sn-candidate-${"c".repeat(64)}`,
  attemptId: "attempt-ledger-event-0001",
  attemptNumber: 1,
  proofStatus: "marker_verification_unavailable" as const,
};
const auditFixture: Audit = {
  id: "audit-id",
  action: "create",
  entity: "servicenow-write-command",
  entityId: "command-id-0000000001",
  actor: "admin",
  details: {},
  createdAt: "2026-07-23T01:00:00.000Z",
};

function commandSummary(overrides: Partial<ServiceNowWriteCommandSummary> = {}): ServiceNowWriteCommandSummary {
  return {
    id: "command-id-0000000001",
    version: 1,
    commandType: "create_incident",
    status: "validated",
    sourceType: "manual",
    operationReference: "manual-op:command-id-0000000001",
    targetTable: "incident",
    commandMaterialHash: hash,
    normalizedPayloadHash: hash,
    providerCorrelationMarker: marker,
    validationSummary: { valid: true },
    safeRequestSummary: {},
    safeResponseSummary: {},
    retryAllowed: false,
    attemptCount: 0,
    maxAttempts: 3,
    createdBy: "admin-id",
    createdAt: "2026-07-23T01:00:00.000Z",
    updatedAt: "2026-07-23T01:00:00.000Z",
    ...overrides,
  };
}

function adapter(overrides: Record<string, unknown> = {}) {
  return {
    preview: () => ({
      method: "POST" as const,
      endpointPath: "/api/now/table/incident",
      targetTable: "incident",
      fieldNames: ["description", "short_description"],
    }),
    execute: vi.fn(),
    readBack: vi.fn(),
    testReadiness: vi.fn(),
    ...overrides,
  };
}

function begin(normalizedPayload: NormalizedServiceNowWriteCommand, liveAttemptCount: number) {
  return {
    attempt_number: 1,
    command_type: normalizedPayload.commandType,
    normalized_payload: normalizedPayload,
    target_table: "incident",
    target_sys_id: normalizedPayload.targetSysId || null,
    target_number: normalizedPayload.targetNumber || null,
    max_attempts: 3,
    live_attempt_count: liveAttemptCount,
    command_version: 1,
  };
}

function freshReadiness() {
  return {
    getCommandExecutionContext: vi.fn(async () => ({
      connection_id: connectionId,
      normalized_payload: normalizedCreate,
    })),
    getReadinessProof: vi.fn(async () => ({
      connection_id: connectionId,
      configuration_fingerprint: configurationFingerprint,
      tested_at: "2026-07-23T01:00:00.000Z",
      expires_at: "2026-07-23T01:10:00.000Z",
      test_status: "succeeded" as const,
      safe_http_status: 200,
      tested_by_user_id: session.userId,
      safe_error_code: null,
      updated_at: "2026-07-23T01:00:00.000Z",
    })),
  };
}

describe("ServiceNow write service", () => {
  it("deduplicates a lost-response manual command replay with one provider marker", async () => {
    const identity = await issueManualOperationIdentity({
      session,
      commandType: "create_incident",
    }, {
      env,
      now: () => new Date("2026-07-23T01:00:00.000Z"),
      randomHex: () => "c".repeat(64),
    });
    let storedPayload: Record<string, unknown> | undefined;
    const createStored = vi.fn(async (payload: Record<string, unknown>) => {
      if (!storedPayload) {
        storedPayload = payload;
        return {
          action: "created" as const,
          command_id: payload.commandId as string,
          command_status: "validated" as const,
          command_attempt_count: 0,
          command_version: 1,
          command_material_hash: payload.commandMaterialHash as string,
          normalized_payload_hash: payload.normalizedPayloadHash as string,
        };
      }
      if (storedPayload.commandMaterialHash !== payload.commandMaterialHash) {
        throw new Error("SERVICENOW_WRITE_IDEMPOTENCY_CONFLICT");
      }
      return {
        action: "unchanged" as const,
        command_id: storedPayload.commandId as string,
        command_status: "validated" as const,
        command_attempt_count: 0,
        command_version: 1,
        command_material_hash: storedPayload.commandMaterialHash as string,
        normalized_payload_hash: storedPayload.normalizedPayloadHash as string,
      };
    });
    const repository = {
      ensureConnection: vi.fn(async () => connectionId),
      getActiveMapping: vi.fn(async () => ({
        id: "mapping-id-0000000001",
        fieldMapping: serviceNowDefaultWriteMapping("create_incident"),
      })),
      createCommand: createStored,
      getCommand: vi.fn(async (commandIdValue: string) => commandSummary({
        id: commandIdValue,
        operationReference: identity.operationReference,
        providerCorrelationMarker: storedPayload?.providerCorrelationMarker as string,
      })),
    } as unknown as ServiceNowWriteRepository;
    let sequence = 0;
    const request = {
      commandType: "create_incident" as const,
      sourceType: "manual" as const,
      manualOperationToken: identity.operationToken,
      payload: { shortDescription: "Short", description: "Description" },
      session,
      requestId: "request-replay-0001",
      correlationId: "request-replay-0001",
    };
    const dependencies = {
      env,
      repository,
      audit: async () => auditFixture,
      now: () => new Date("2026-07-23T01:00:30.000Z"),
      createId: () => `command-replay-${++sequence}`.padEnd(20, "0"),
    };
    const first = await createCommand(request, dependencies);
    const replay = await createCommand({
      ...request,
      requestId: "request-replay-0002",
      correlationId: "request-replay-0002",
    }, dependencies);
    expect(replay.id).toBe(first.id);
    expect(createStored).toHaveBeenCalledTimes(2);
    expect(new Set(createStored.mock.calls.map(([payload]) => payload.providerCorrelationMarker))).toHaveLength(1);
    await expect(createCommand({
      ...request,
      payload: { shortDescription: "Changed", description: "Description" },
    }, dependencies)).rejects.toMatchObject({ code: "SERVICENOW_WRITE_IDEMPOTENCY_CONFLICT" });
    for (const changed of [
      {
        ...request,
        payload: {
          ...request.payload,
          externalReferences: { source: "changed" },
        },
      },
      {
        ...request,
        payload: {
          ...request.payload,
          supperTicketNo: "T-CHANGED",
        },
      },
      { ...request, maxAttempts: 2 },
    ]) {
      await expect(createCommand(changed, dependencies)).rejects.toMatchObject({
        code: "SERVICENOW_WRITE_IDEMPOTENCY_CONFLICT",
      });
    }
    expect(new Set(createStored.mock.calls.map(([payload]) => payload.idempotencyKey))).toHaveLength(1);
    expect(new Set(createStored.mock.calls.map(([payload]) => payload.providerCorrelationMarker))).toHaveLength(1);
  });

  it("validates and submits raw command material once while SQL owns normalized identity", async () => {
    const createStored = vi.fn(async () => ({
      action: "created" as const,
      command_id: "command-id-0000000001",
      command_status: "validated" as const,
      command_attempt_count: 0,
      command_version: 1,
      command_material_hash: hash,
      normalized_payload_hash: hash,
    }));
    const audit = vi.fn(async () => auditFixture);
    const repository = {
      ensureConnection: vi.fn(async () => "connection"),
      getActiveMapping: vi.fn(async () => ({
        id: "mapping-id-0000000001",
        fieldMapping: serviceNowDefaultWriteMapping("create_incident"),
      })),
      createCommand: createStored,
      getCommand: vi.fn(async () => commandSummary()),
    } as unknown as ServiceNowWriteRepository;
    const result = await createCommand({
      commandType: "create_incident",
      sourceType: "supper_ticket",
      sourceEntityReference: "ticket:T-100",
      operationReference: "create:initial",
      payload: { shortDescription: "Short", description: "Description", impact: "2" },
      session,
      requestId: "request-service-0001",
      correlationId: "request-service-0001",
    }, {
      env,
      repository,
      audit,
      now: () => new Date("2026-07-23T01:00:00.000Z"),
      createId: () => "command-id-0000000001",
    });
    expect(result.status).toBe("validated");
    expect(createStored).toHaveBeenCalledWith(expect.objectContaining({
      sourceEntityReference: "ticket:T-100",
      operationReference: "create:initial",
      payload: expect.objectContaining({ description: "Description" }),
      normalizedPayload: expect.objectContaining({
        schemaVersion: "servicenow-write-normalized-v2",
        fields: expect.objectContaining({ correlation_id: expect.stringMatching(/^SUPPER:[a-f0-9]{64}$/) }),
      }),
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      commandMaterialHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      normalizedPayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      entity: "servicenow-write-command",
      details: expect.not.objectContaining({ payload: expect.anything() }),
    }));
  });

  it("records a dry-run without a confirmation or provider mutation", async () => {
    const finishAttempt = vi.fn(async () => ({
      command_id: "command-id-0000000001",
      command_status: "dry_run_ready" as const,
      command_attempt_count: 0,
      command_version: 2,
    }));
    const writeAdapter = adapter();
    const repository = {
      beginAttempt: vi.fn(async () => begin(normalizedCreate, 0)),
      finishAttempt,
      getCommand: vi.fn(async () => commandSummary({ status: "dry_run_ready", version: 2 })),
    } as unknown as ServiceNowWriteRepository;
    const result = await executeCommandDryRun({
      commandId: "command-id-0000000001",
      session,
      requestId: "request-service-0002",
      correlationId: "request-service-0002",
    }, {
      env,
      repository,
      adapter: writeAdapter,
      audit: async () => auditFixture,
      now: () => new Date("2026-07-23T01:01:00.000Z"),
      createId: () => "attempt-id-0000000001",
    });
    expect(result.status).toBe("dry_run_ready");
    expect(writeAdapter.execute).not.toHaveBeenCalled();
    expect(finishAttempt).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "dry_run",
      deliveryDisposition: "definitely_not_sent",
      responseSummary: { validated: true, providerWritePerformed: false },
    }));
  });

  it("passes one-time confirmation material to SQL and persists confirmed success", async () => {
    const finishAttempt = vi.fn(async () => ({
      command_id: "command-id-0000000001",
      command_status: "succeeded" as const,
      command_attempt_count: 1,
      command_target_sys_id: "a".repeat(32),
      command_target_number: "INC0010001",
      command_version: 3,
    }));
    const beginAttempt = vi.fn(async () => begin(normalizedCreate, 1));
    const repository = {
      ...freshReadiness(),
      beginAttempt,
      finishAttempt,
      getCommand: vi.fn(async () => commandSummary({
        version: 3,
        status: "succeeded",
        attemptCount: 1,
        targetSysId: "a".repeat(32),
        targetNumber: "INC0010001",
        deliveryDisposition: "confirmed_succeeded",
      })),
    } as unknown as ServiceNowWriteRepository;
    const result = await executeCommand({
      commandId: "command-id-0000000001",
      session,
      requestId: "request-service-0003",
      correlationId: "request-service-0003",
      confirmation,
    }, {
      env,
      repository,
      adapter: adapter({
        execute: vi.fn(async () => ({
          requestSummary: { method: "POST" as const, endpointPath: "/api/now/table/incident", targetTable: "incident", fieldNames: ["short_description"] },
          responseSummary: { httpStatus: 201, sysId: "a".repeat(32), number: "INC0010001" },
          targetSysId: "a".repeat(32),
          targetNumber: "INC0010001",
          mutationCandidate: {
            sysId: "a".repeat(32),
            number: "INC0010001",
            httpStatus: 201,
            source: "mutation_response" as const,
          },
        })),
      }),
      audit: async () => auditFixture,
      now: () => new Date("2026-07-23T01:02:00.000Z"),
      createId: () => "attempt-id-0000000002",
    });
    expect(result).toMatchObject({ status: "succeeded", targetNumber: "INC0010001" });
    expect(beginAttempt).toHaveBeenCalledWith(expect.objectContaining({
      confirmed: true,
      expectedVersion: 1,
      expectedNormalizedPayloadHash: hash,
      confirmationNonceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(finishAttempt).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "succeeded",
      deliveryDisposition: "confirmed_succeeded",
      targetSysId: "a".repeat(32),
      mutationCandidateSysId: "a".repeat(32),
      mutationCandidateNumber: "INC0010001",
      mutationCandidateHttpStatus: 201,
      mutationCandidateSource: "mutation_response",
    }));
  });

  it("passes exact G2 marker recovery identity to the SQL finish payload", async () => {
    const finishAttempt = vi.fn(async () => ({
      command_id: "command-id-0000000001",
      command_status: "succeeded" as const,
      command_attempt_count: 1,
      command_target_sys_id: "e".repeat(32),
      command_target_number: "INC0010005",
      command_version: 3,
    }));
    const repository = {
      ...freshReadiness(),
      beginAttempt: vi.fn(async () => begin(normalizedCreate, 1)),
      finishAttempt,
      getCommand: vi.fn(async () => commandSummary({ version: 3, status: "succeeded" })),
    } as unknown as ServiceNowWriteRepository;
    await executeCommand({
      commandId: "command-id-0000000001",
      session,
      requestId: "request-service-g2-0001",
      correlationId: "request-service-g2-0001",
      confirmation,
    }, {
      env,
      repository,
      adapter: adapter({
        execute: vi.fn(async () => ({
          requestSummary: {
            method: "GET" as const,
            endpointPath: "/api/now/table/incident",
            targetTable: "incident",
            fieldNames: ["correlation_id", "number", "state", "sys_id"],
            targetSysId: "e".repeat(32),
            targetNumber: "INC0010005",
            lookupClassification: "correlation_marker_exact" as const,
          },
          responseSummary: {
            httpStatus: 200,
            sysId: "e".repeat(32),
            number: "INC0010005",
            recoveredByCorrelationMarker: true,
            providerWritePerformed: false,
            exactMarkerVerified: true,
          },
          targetSysId: "e".repeat(32),
          targetNumber: "INC0010005",
        })),
      }),
      audit: async () => auditFixture,
      now: () => new Date("2026-07-23T01:02:00.000Z"),
      createId: () => "attempt-id-g2-000000001",
    });
    expect(finishAttempt).toHaveBeenCalledWith(expect.objectContaining({
      targetSysId: "e".repeat(32),
      targetNumber: "INC0010005",
      requestSummary: expect.objectContaining({
        method: "GET",
        lookupClassification: "correlation_marker_exact",
        targetSysId: "e".repeat(32),
        targetNumber: "INC0010005",
      }),
      responseSummary: expect.objectContaining({
        sysId: "e".repeat(32),
        number: "INC0010005",
        exactMarkerVerified: true,
      }),
    }));
  });

  it("does not rewrite a recovered Attempt when a late provider result arrives", async () => {
    const finishAttempt = vi.fn(async () => {
      throw new Error("SERVICENOW_WRITE_ATTEMPT_ALREADY_RECOVERED");
    });
    const repository = {
      ...freshReadiness(),
      beginAttempt: vi.fn(async () => begin(normalizedCreate, 1)),
      finishAttempt,
      getCommand: vi.fn(),
    } as unknown as ServiceNowWriteRepository;
    await expect(executeCommand({
      commandId: "command-id-0000000001",
      session,
      requestId: "request-late-response-0001",
      correlationId: "request-late-response-0001",
      confirmation,
    }, {
      env,
      repository,
      adapter: adapter({
        execute: vi.fn(async () => ({
          requestSummary: { method: "POST" as const, endpointPath: "/api/now/table/incident", targetTable: "incident", fieldNames: ["short_description"] },
          responseSummary: { httpStatus: 201, sysId: "a".repeat(32), number: "INC0010001" },
          targetSysId: "a".repeat(32),
          targetNumber: "INC0010001",
        })),
      }),
      audit: async () => auditFixture,
      now: () => new Date("2026-07-23T01:02:00.000Z"),
      createId: () => "attempt-late-response-0001",
    })).rejects.toMatchObject({ code: "SERVICENOW_WRITE_ATTEMPT_ALREADY_RECOVERED" });
    expect(finishAttempt).toHaveBeenCalledOnce();
  });

  it("schedules retry only for an explicitly safe-to-retry provider outcome", async () => {
    const finishAttempt = vi.fn(async () => ({
      command_id: "command-id-0000000001",
      command_status: "retry_scheduled" as const,
      command_attempt_count: 1,
      command_next_retry_at: "2026-07-23T01:03:30.000Z",
      command_version: 3,
    }));
    const repository = {
      ...freshReadiness(),
      beginAttempt: vi.fn(async () => begin(normalizedUpdate, 1)),
      finishAttempt,
      getCommand: vi.fn(async () => commandSummary({
        commandType: "update_incident",
        status: "retry_scheduled",
        retryAllowed: true,
        attemptCount: 1,
        nextRetryAt: "2026-07-23T01:03:30.000Z",
      })),
    } as unknown as ServiceNowWriteRepository;
    const boundary = serviceNowError({
      category: "rate_limit",
      code: "SERVICENOW_WRITE_RATE_LIMITED",
      safeMessage: "ServiceNow temporarily rate limited the write request",
      retryable: true,
      operation: "ticket.update",
      correlationId: correlationIdSchema.parse("request-service-0004"),
    });
    const safeRetry = serviceNowWriteExecutionError(boundary, {
      deliveryDisposition: "safe_to_retry",
      failurePhase: "mutation_response",
      retryAllowed: true,
    });
    const result = await executeCommand({
      commandId: "command-id-0000000001",
      session,
      requestId: "request-service-0004",
      correlationId: "request-service-0004",
      confirmation,
    }, {
      env,
      repository,
      adapter: adapter({ execute: vi.fn(async () => { throw safeRetry; }) }),
      audit: async () => auditFixture,
      now: () => new Date("2026-07-23T01:03:00.000Z"),
      createId: () => "attempt-id-0000000003",
    });
    expect(result.status).toBe("retry_scheduled");
    expect(finishAttempt).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      deliveryDisposition: "safe_to_retry",
      retryAllowed: true,
      nextRetryAt: "2026-07-23T01:03:30.000Z",
    }));
  });

  it("routes ambiguous post-dispatch outcomes to reconciliation and blocks retry", async () => {
    const finishAttempt = vi.fn(async () => ({
      command_id: "command-id-0000000001",
      command_status: "reconciliation_required" as const,
      command_attempt_count: 1,
      command_version: 3,
    }));
    const repository = {
      ...freshReadiness(),
      beginAttempt: vi.fn(async () => begin(normalizedUpdate, 1)),
      finishAttempt,
      getCommand: vi.fn(async () => commandSummary({
        commandType: "update_incident",
        status: "reconciliation_required",
        retryAllowed: false,
        attemptCount: 1,
        deliveryDisposition: "may_have_committed",
        reconciliationReason: "Mutation dispatch ended without a definitive provider response",
      })),
    } as unknown as ServiceNowWriteRepository;
    const boundary = serviceNowError({
      category: "timeout",
      code: "SERVICENOW_WRITE_TIMEOUT",
      safeMessage: "ServiceNow request timed out",
      retryable: true,
      operation: "ticket.update",
      correlationId: correlationIdSchema.parse("request-service-0005"),
    });
    const uncertain = serviceNowWriteExecutionError(boundary, {
      deliveryDisposition: "may_have_committed",
      failurePhase: "mutation_dispatch",
      retryAllowed: false,
      reconciliationReason: "Mutation dispatch ended without a definitive provider response",
    });
    const result = await executeCommand({
      commandId: "command-id-0000000001",
      session,
      requestId: "request-service-0005",
      correlationId: "request-service-0005",
      confirmation,
    }, {
      env,
      repository,
      adapter: adapter({ execute: vi.fn(async () => { throw uncertain; }) }),
      audit: async () => auditFixture,
      now: () => new Date("2026-07-23T01:04:00.000Z"),
      createId: () => "attempt-id-0000000004",
    });
    expect(result.status).toBe("reconciliation_required");
    expect(finishAttempt).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "uncertain",
      deliveryDisposition: "may_have_committed",
      retryAllowed: false,
    }));
    const uncertainAttempt = finishAttempt.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(uncertainAttempt[0]).not.toHaveProperty("nextRetryAt");
  });

  it("persists only bounded create mutation-candidate evidence after post-write proof fails", async () => {
    const finishAttempt = vi.fn(async () => ({
      command_id: "command-id-0000000001",
      command_status: "reconciliation_required" as const,
      command_attempt_count: 1,
      command_version: 3,
    }));
    const repository = {
      ...freshReadiness(),
      beginAttempt: vi.fn(async () => begin(normalizedCreate, 1)),
      finishAttempt,
      getCommand: vi.fn(async () => commandSummary({
        status: "reconciliation_required",
        retryAllowed: false,
        attemptCount: 1,
        deliveryDisposition: "may_have_committed",
      })),
    } as unknown as ServiceNowWriteRepository;
    const boundary = serviceNowError({
      category: "timeout",
      code: "SERVICENOW_WRITE_TIMEOUT",
      safeMessage: "ServiceNow post-write verification timed out",
      retryable: false,
      operation: "ticket.create",
      correlationId: correlationIdSchema.parse("request-candidate-persistence"),
    });
    const uncertain = serviceNowWriteExecutionError(boundary, {
      deliveryDisposition: "may_have_committed",
      failurePhase: "read_back",
      retryAllowed: false,
      reconciliationReason: "Post-create correlation-marker verification was not exact",
      mutationCandidateSysId: mutationCandidate.sysId,
      mutationCandidateNumber: mutationCandidate.number,
      mutationHttpStatus: mutationCandidate.httpStatus,
      safeResponseSummary: {
        httpStatus: 201,
        mutationCandidateObserved: true,
        candidateSysId: mutationCandidate.sysId,
        candidateNumber: mutationCandidate.number,
        mutationHttpStatus: 201,
        postWriteMarkerVerified: false,
      },
    });
    await executeCommand({
      commandId: "command-id-0000000001",
      session,
      requestId: "request-candidate-persistence",
      correlationId: "request-candidate-persistence",
      confirmation,
    }, {
      env,
      repository,
      adapter: adapter({ execute: vi.fn(async () => { throw uncertain; }) }),
      audit: async () => auditFixture,
      now: () => new Date("2026-07-23T01:04:00.000Z"),
      createId: () => "attempt-candidate-persistence",
    });
    expect(finishAttempt).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "uncertain",
      responseSummary: {
        httpStatus: 201,
        mutationCandidateObserved: true,
        candidateSysId: mutationCandidate.sysId,
        candidateNumber: mutationCandidate.number,
        mutationHttpStatus: 201,
        postWriteMarkerVerified: false,
      },
      mutationCandidateSysId: mutationCandidate.sysId,
      mutationCandidateNumber: mutationCandidate.number,
      mutationCandidateHttpStatus: 201,
      mutationCandidateSource: "mutation_response",
    }));
    expect(JSON.stringify(finishAttempt.mock.calls[0])).not.toContain("raw provider value");
    expect(JSON.stringify(finishAttempt.mock.calls[0])).not.toContain("authorization");
  });

  it("requires a matching fresh readiness proof before consuming a live attempt", async () => {
    const beginAttempt = vi.fn();
    const providerExecute = vi.fn();
    const repository = {
      getCommandExecutionContext: vi.fn(async () => ({
        connection_id: connectionId,
        normalized_payload: normalizedCreate,
      })),
      getReadinessProof: vi.fn(async () => ({
        connection_id: connectionId,
        configuration_fingerprint: configurationFingerprint,
        tested_at: "2026-07-23T01:00:00.000Z",
        expires_at: "2026-07-23T01:01:00.000Z",
        test_status: "succeeded",
        safe_http_status: 200,
        tested_by_user_id: session.userId,
        safe_error_code: null,
        updated_at: "2026-07-23T01:00:00.000Z",
      })),
      beginAttempt,
    } as unknown as ServiceNowWriteRepository;
    await expect(executeCommand({
      commandId: "command-id-0000000001",
      session,
      requestId: "request-readiness-expired",
      correlationId: "request-readiness-expired",
      confirmation,
    }, {
      env,
      repository,
      adapter: adapter({ execute: providerExecute }),
      now: () => new Date("2026-07-23T01:02:00.000Z"),
    })).rejects.toMatchObject({ code: "SERVICENOW_WRITE_READINESS_REQUIRED" });
    expect(beginAttempt).not.toHaveBeenCalled();
    expect(providerExecute).not.toHaveBeenCalled();
  });

  it("requires proof configuration fingerprint parity, not only the live switch", () => {
    const proof = {
      connection_id: connectionId,
      configuration_fingerprint: configurationFingerprint,
      tested_at: "2026-07-23T01:00:00.000Z",
      expires_at: "2026-07-23T01:10:00.000Z",
      test_status: "succeeded" as const,
      safe_http_status: 200,
      tested_by_user_id: session.userId,
      safe_error_code: null,
      updated_at: "2026-07-23T01:00:00.000Z",
    };
    expect(getServiceNowWriteReadiness(env, undefined, new Date("2026-07-23T01:01:00.000Z")))
      .toMatchObject({ liveWriteEnabled: true, connectionTested: false, liveWriteReady: false });
    expect(getServiceNowWriteReadiness(env, proof, new Date("2026-07-23T01:01:00.000Z")))
      .toMatchObject({ connectionTested: true, liveWriteReady: true });
    expect(getServiceNowWriteReadiness(
      { ...env, SERVICENOW_CREDENTIAL_VERSION: "rotated" },
      proof,
      new Date("2026-07-23T01:01:00.000Z"),
    )).toMatchObject({
      connectionTested: false,
      liveWriteReady: false,
      safeErrorCode: "SERVICENOW_WRITE_CONNECTION_UNTESTED",
    });
  });

  it("issues a server nonce and records read-back reconciliation without mutation", async () => {
    const issueConfirmation = vi.fn(async () => ({
      command_id: "command-id-0000000001",
      command_version: 1,
      normalized_payload_hash: hash,
      confirmation_expires_at: "2026-07-23T01:07:00.000Z",
    }));
    const issued = await issueCommandConfirmation({
      commandId: "command-id-0000000001",
      action: "reconcile_by_read_back",
      expectedVersion: 1,
      expectedNormalizedPayloadHash: hash,
      session,
    }, {
      env,
      repository: { issueConfirmation } as unknown as ServiceNowWriteRepository,
      now: () => new Date("2026-07-23T01:05:00.000Z"),
      createNonce: () => "server-generated-nonce-with-entropy",
    });
    expect(issued.confirmationNonce).toBe("server-generated-nonce-with-entropy");
    expect(issueConfirmation).toHaveBeenCalledWith(expect.objectContaining({
      confirmationNonceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      expectedVersion: 1,
    }));

    const providerReadBack = vi.fn(async () => ({
      result: "confirmed_succeeded" as const,
      summary: { method: "correlation_marker", matchCount: 1 },
      targetSysId: "c".repeat(32),
      targetNumber: "INC0010003",
    }));
    const reconcile = vi.fn(async (payload: Record<string, unknown>) => {
      void payload;
      return {
        command_id: "command-id-0000000001",
        command_status: "succeeded" as const,
        command_version: 2,
        reconciliation_result: "confirmed_succeeded",
      };
    });
    const command = await reconcileCommand({
      commandId: "command-id-0000000001",
      action: "reconcile_by_read_back",
      session,
      requestId: "request-service-0006",
      correlationId: "request-service-0006",
      confirmation,
    }, {
      env,
      repository: {
        getNormalizedCommand: vi.fn(async () => normalizedCreate),
        reconcile,
        getCommand: vi.fn(async () => commandSummary({ version: 2, status: "succeeded" })),
      } as unknown as ServiceNowWriteRepository,
      adapter: adapter({ readBack: providerReadBack }),
      audit: async () => auditFixture,
      now: () => new Date("2026-07-23T01:06:00.000Z"),
    });
    expect(command.status).toBe("succeeded");
    expect(providerReadBack).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      action: "reconcile_by_read_back",
      result: "confirmed_succeeded",
      safeReadBackSummary: {
        method: "correlation_marker",
        matchCount: 1,
        evidenceClassification: "provider_matched",
        targetSysId: "c".repeat(32),
        targetNumber: "INC0010003",
      },
      confirmationNonceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it("recovers a stuck attempt through the ledger without loading provider runtime", async () => {
    const recoverAttempt = vi.fn(async (input: unknown) => {
      void input;
      return {
        command_id: "command-id-0000000001",
        command_status: "reconciliation_required" as const,
        command_attempt_count: 1,
        command_version: 3,
      };
    });
    const getCommand = vi.fn(async () => commandSummary({
      version: 3,
      status: "reconciliation_required",
      attemptCount: 1,
      safeResponseSummary: {
        recoveredByAdministrator: true,
        recoveryOperationProviderRequestPerformed: false,
        originalMutationOutcome: "unknown",
      },
    }));
    const result = await recoverStuckAttempt({
      commandId: "command-id-0000000001",
      session,
      requestId: "request-recover-stuck-0001",
      confirmation: {
        ...confirmation,
        mutationCandidateEventId: ledgerMutationCandidate.id,
      },
    }, {
      env,
      repository: { recoverAttempt, getCommand } as unknown as ServiceNowWriteRepository,
      audit: async () => auditFixture,
      now: () => new Date("2026-07-23T01:06:00.000Z"),
    });
    expect(result.status).toBe("reconciliation_required");
    expect(result.safeResponseSummary).toEqual({
      recoveredByAdministrator: true,
      recoveryOperationProviderRequestPerformed: false,
      originalMutationOutcome: "unknown",
    });
    expect(recoverAttempt).toHaveBeenCalledWith(expect.objectContaining({
      commandId: "command-id-0000000001",
      actorUserId: "admin-id",
      mutationCandidateEventId: ledgerMutationCandidate.id,
      confirmationNonceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(recoverAttempt.mock.calls[0]?.[0]).not.toHaveProperty("recoveredAt");
  });

  it("returns a bounded error when recovery is requested before the lease", async () => {
    await expect(recoverStuckAttempt({
      commandId: "command-id-0000000001",
      session,
      requestId: "request-recover-too-early-0001",
      confirmation,
    }, {
      env,
      repository: {
        recoverAttempt: vi.fn(async () => {
          throw new Error("SERVICENOW_WRITE_ATTEMPT_RECOVERY_TOO_EARLY");
        }),
      } as unknown as ServiceNowWriteRepository,
      audit: async () => auditFixture,
    })).rejects.toMatchObject({
      status: 409,
      code: "SERVICENOW_WRITE_ATTEMPT_RECOVERY_TOO_EARLY",
    });
  });

  it("rejects stale candidate identity before reconciliation reaches the ledger RPC", async () => {
    const reconcile = vi.fn();
    await expect(reconcileCommand({
      commandId: "command-id-0000000001",
      action: "mark_succeeded_after_verification",
      session,
      requestId: "request-stale-candidate-0001",
      correlationId: "request-stale-candidate-0001",
      confirmation: {
        ...confirmation,
        mutationCandidateEventId: `sn-candidate-${"d".repeat(64)}`,
      },
      mutationCandidateEventId: `sn-candidate-${"d".repeat(64)}`,
      verifiedTargetSysId: ledgerMutationCandidate.sysId,
      verifiedTargetNumber: ledgerMutationCandidate.number,
      verificationAcknowledged: true,
      verificationNote: "Independent candidate verification completed.",
    }, {
      env,
      repository: {
        getNormalizedCommand: vi.fn(async () => normalizedCreate),
        getMutationCandidate: vi.fn(async () => ledgerMutationCandidate),
        reconcile,
      } as unknown as ServiceNowWriteRepository,
      audit: async () => auditFixture,
    })).rejects.toMatchObject({ code: "SERVICENOW_WRITE_MUTATION_CANDIDATE_STALE" });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("keeps an exact target with inconclusive mutation evidence unresolved", async () => {
    const readBack = vi.fn(async () => ({
      result: "inconclusive" as const,
      summary: {
        method: "exact_sys_id",
        matchedFields: 1,
        expectedFields: 2,
      },
      targetSysId: "b".repeat(32),
      targetNumber: "INC0010004",
    }));
    const reconcile = vi.fn(async () => ({
      command_id: "command-id-0000000001",
      command_status: "reconciliation_required" as const,
      command_version: 2,
      reconciliation_result: "inconclusive",
    }));
    const result = await reconcileCommand({
      commandId: "command-id-0000000001",
      action: "reconcile_by_read_back",
      session,
      requestId: "request-inconclusive-proof",
      correlationId: "request-inconclusive-proof",
      confirmation,
    }, {
      env,
      repository: {
        getNormalizedCommand: vi.fn(async () => normalizedCreate),
        reconcile,
        getCommand: vi.fn(async () => commandSummary({
          version: 2,
          status: "reconciliation_required",
        })),
      } as unknown as ServiceNowWriteRepository,
      adapter: adapter({ readBack }),
      audit: async () => auditFixture,
    });
    expect(result.status).toBe("reconciliation_required");
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      result: "inconclusive",
      safeReadBackSummary: expect.objectContaining({
        evidenceClassification: "provider_inconclusive",
      }),
    }));
  });

  it("completes candidate-aware read-back only when the provider pair matches the POST candidate", async () => {
    const reconcile = vi.fn(async () => ({
      command_id: "command-id-0000000001",
      command_status: "succeeded" as const,
      command_version: 2,
      reconciliation_result: "confirmed_succeeded",
    }));
    await reconcileCommand({
      commandId: "command-id-0000000001",
      action: "reconcile_by_read_back",
      session,
      requestId: "request-candidate-match",
      correlationId: "request-candidate-match",
      confirmation,
    }, {
      env,
      repository: {
        getNormalizedCommand: vi.fn(async () => normalizedCreate),
        getMutationCandidate: vi.fn(async () => mutationCandidate),
        reconcile,
        getCommand: vi.fn(async () => commandSummary({ status: "succeeded", version: 2 })),
      } as unknown as ServiceNowWriteRepository,
      adapter: adapter({
        readBack: vi.fn(async () => ({
          result: "confirmed_succeeded" as const,
          summary: { method: "correlation_marker", matchCount: 1 },
          targetSysId: mutationCandidate.sysId,
          targetNumber: mutationCandidate.number,
        })),
      }),
      audit: async () => auditFixture,
    });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      result: "confirmed_succeeded",
      targetSysId: mutationCandidate.sysId,
      targetNumber: mutationCandidate.number,
      safeReadBackSummary: expect.objectContaining({
        evidenceClassification: "provider_matched",
        mutationCandidateMatched: true,
      }),
    }));
  });

  it.each([
    ["sys_id mismatch", "c".repeat(32), mutationCandidate.number],
    ["number mismatch", mutationCandidate.sysId, "INC0099999"],
  ])("keeps candidate-aware read-back unresolved after %s", async (_label, targetSysId, targetNumber) => {
    const reconcile = vi.fn(async (payload: Record<string, unknown>) => {
      void payload;
      return {
        command_id: "command-id-0000000001",
        command_status: "reconciliation_required" as const,
        command_version: 2,
        reconciliation_result: "read_back_failed",
      };
    });
    const dependencies = {
      env,
      repository: {
        getNormalizedCommand: vi.fn(async () => normalizedCreate),
        getMutationCandidate: vi.fn(async () => mutationCandidate),
        reconcile,
        getCommand: vi.fn(async () => commandSummary({
          status: "reconciliation_required",
          version: 2,
        })),
      } as unknown as ServiceNowWriteRepository,
      adapter: adapter({
        readBack: vi.fn(async () => ({
          result: "confirmed_succeeded" as const,
          summary: { method: "correlation_marker", matchCount: 1 },
          targetSysId,
          targetNumber,
        })),
      }),
      audit: async () => auditFixture,
    };
    await reconcileCommand({
      commandId: "command-id-0000000001",
      action: "reconcile_by_read_back",
      session,
      requestId: `request-candidate-conflict-${_label.replaceAll(" ", "-")}`,
      correlationId: `request-candidate-conflict-${_label.replaceAll(" ", "-")}`,
      confirmation,
    }, dependencies);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      result: "read_back_failed",
      targetSysId: "",
      targetNumber: "",
      safeReadBackSummary: expect.objectContaining({
        evidenceClassification: "provider_target_conflict",
        errorCode: "SERVICENOW_WRITE_MUTATION_CANDIDATE_CONFLICT",
      }),
    }));
  });

  it("does not let a later single marker row bypass the persisted candidate", async () => {
    const reconcile = vi.fn(async (payload: Record<string, unknown>) => {
      void payload;
      return {
        command_id: "command-id-0000000001",
        command_status: "reconciliation_required" as const,
        command_version: 2,
        reconciliation_result: "read_back_failed",
      };
    });
    const readBack = vi.fn()
      .mockResolvedValueOnce({ result: "ambiguous", summary: { method: "correlation_marker", matchCount: 2 } })
      .mockResolvedValueOnce({
        result: "confirmed_succeeded",
        summary: { method: "correlation_marker", matchCount: 1 },
        targetSysId: "c".repeat(32),
        targetNumber: "INC0099999",
      });
    const repository = {
      getNormalizedCommand: vi.fn(async () => normalizedCreate),
      getMutationCandidate: vi.fn(async () => mutationCandidate),
      reconcile,
      getCommand: vi.fn(async () => commandSummary({
        status: "reconciliation_required",
        version: 2,
      })),
    } as unknown as ServiceNowWriteRepository;
    for (const suffix of ["ambiguous", "later-conflict"]) {
      await reconcileCommand({
        commandId: "command-id-0000000001",
        action: "reconcile_by_read_back",
        session,
        requestId: `request-candidate-${suffix}`,
        correlationId: `request-candidate-${suffix}`,
        confirmation,
      }, {
        env,
        repository,
        adapter: adapter({ readBack }),
        audit: async () => auditFixture,
      });
    }
    expect(reconcile.mock.calls[0][0]).toMatchObject({
      result: "ambiguous",
      safeReadBackSummary: expect.objectContaining({ evidenceClassification: "provider_ambiguous" }),
    });
    expect(reconcile.mock.calls[1][0]).toMatchObject({
      result: "read_back_failed",
      safeReadBackSummary: expect.objectContaining({ evidenceClassification: "provider_target_conflict" }),
    });
  });

  it("marks an uncertain journal command successful only with a verified target pair and no replay", async () => {
    const readBack = vi.fn(async () => ({
      result: "confirmed_succeeded" as const,
      summary: { method: "exact_target", matchCount: 1 },
      targetSysId: "b".repeat(32),
      targetNumber: "INC0010004",
    }));
    const providerExecute = vi.fn();
    const reconcile = vi.fn(async () => ({
      command_id: "command-id-0000000001",
      command_status: "succeeded" as const,
      command_version: 2,
      reconciliation_result: "confirmed_succeeded",
    }));
    const result = await reconcileCommand({
      commandId: "command-id-0000000001",
      action: "mark_succeeded_after_verification",
      session,
      requestId: "request-service-reconcile-journal",
      correlationId: "request-service-reconcile-journal",
      confirmation,
      verifiedTargetSysId: "b".repeat(32),
      verifiedTargetNumber: "INC0010004",
      verificationAcknowledged: true,
      verificationNote: "Verified by exact Incident read-back.",
    }, {
      env,
      repository: {
        getNormalizedCommand: vi.fn(async () => ({
          schemaVersion: "servicenow-write-normalized-v2",
          commandType: "add_work_note",
          targetSysId: "b".repeat(32),
          fields: { work_notes: "Reviewed note" },
        })),
        reconcile,
        getCommand: vi.fn(async () => commandSummary({
          commandType: "add_work_note",
          status: "succeeded",
          targetSysId: "b".repeat(32),
          targetNumber: "INC0010004",
        })),
      } as unknown as ServiceNowWriteRepository,
      adapter: { ...adapter({ readBack }), execute: providerExecute },
      audit: async () => auditFixture,
      now: () => new Date("2026-07-23T01:06:00.000Z"),
    });
    expect(result.status).toBe("succeeded");
    expect(readBack).toHaveBeenCalledOnce();
    expect(providerExecute).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      targetSysId: "b".repeat(32),
      targetNumber: "INC0010004",
      verificationAcknowledged: true,
      safeReadBackSummary: expect.not.objectContaining({
        verificationNote: expect.anything(),
      }),
    }));
  });

  it("records exact provider identity with inconclusive content as manual target verification", async () => {
    const readBack = vi.fn(async () => ({
      result: "inconclusive" as const,
      summary: { method: "exact_sys_id", matchedFields: 1, expectedFields: 2 },
      targetSysId: "b".repeat(32),
      targetNumber: "INC0010004",
    }));
    const reconcile = vi.fn(async () => ({
      command_id: "command-id-0000000001",
      command_status: "succeeded" as const,
      command_version: 2,
      reconciliation_result: "confirmed_succeeded",
    }));
    await reconcileCommand({
      commandId: "command-id-0000000001",
      action: "mark_succeeded_after_verification",
      session,
      requestId: "request-provider-target-manual",
      correlationId: "request-provider-target-manual",
      confirmation,
      verifiedTargetSysId: "b".repeat(32),
      verifiedTargetNumber: "INC0010004",
      verificationAcknowledged: true,
      verificationNote: "Verified the exact target and mutation independently.",
    }, {
      env,
      repository: {
        getNormalizedCommand: vi.fn(async () => normalizedUpdate),
        reconcile,
        getCommand: vi.fn(async () => commandSummary({ status: "succeeded", version: 2 })),
      } as unknown as ServiceNowWriteRepository,
      adapter: adapter({ readBack }),
      audit: async () => auditFixture,
    });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      result: "confirmed_succeeded",
      safeReadBackSummary: expect.objectContaining({
        evidenceClassification: "provider_target_matched_manual_verification",
        providerResult: "inconclusive",
      }),
    }));
  });

  it("rejects a manually verified pair that conflicts with provider read-back", async () => {
    const reconcile = vi.fn();
    await expect(reconcileCommand({
      commandId: "command-id-0000000001",
      action: "mark_succeeded_after_verification",
      session,
      requestId: "request-service-reconcile-conflict",
      correlationId: "request-service-reconcile-conflict",
      confirmation,
      verifiedTargetSysId: "b".repeat(32),
      verifiedTargetNumber: "INC0010004",
      verificationAcknowledged: true,
      verificationNote: "Verified by exact Incident read-back.",
    }, {
      env,
      repository: {
        getNormalizedCommand: vi.fn(async () => normalizedCreate),
        reconcile,
      } as unknown as ServiceNowWriteRepository,
      adapter: adapter({
        readBack: vi.fn(async () => ({
          result: "confirmed_succeeded",
          summary: { method: "correlation_marker", matchCount: 1 },
          targetSysId: "c".repeat(32),
          targetNumber: "INC0010005",
        })),
      }),
    })).rejects.toMatchObject({ code: "SERVICENOW_WRITE_VERIFIED_TARGET_CONFLICT" });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("rejects a non-create manual target that changes the original sys_id", async () => {
    const reconcile = vi.fn();
    const readBack = vi.fn();
    await expect(reconcileCommand({
      commandId: "command-id-0000000001",
      action: "mark_succeeded_after_verification",
      session,
      requestId: "request-update-target-continuity",
      correlationId: "request-update-target-continuity",
      confirmation,
      verifiedTargetSysId: "c".repeat(32),
      verifiedTargetNumber: "INC0010004",
      verificationAcknowledged: true,
      verificationNote: "Verified the exact existing Incident target.",
    }, {
      env,
      repository: {
        getNormalizedCommand: vi.fn(async () => normalizedUpdate),
        reconcile,
      } as unknown as ServiceNowWriteRepository,
      adapter: adapter({ readBack }),
    })).rejects.toMatchObject({
      status: 409,
      code: "SERVICENOW_WRITE_TARGET_CONTINUITY_CONFLICT",
    });
    expect(readBack).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("rejects manual success when the verified pair conflicts with the persisted mutation candidate", async () => {
    const reconcile = vi.fn();
    const readBack = vi.fn();
    await expect(reconcileCommand({
      commandId: "command-id-0000000001",
      action: "mark_succeeded_after_verification",
      session,
      requestId: "request-manual-candidate-conflict",
      correlationId: "request-manual-candidate-conflict",
      confirmation,
      verifiedTargetSysId: "c".repeat(32),
      verifiedTargetNumber: mutationCandidate.number,
      verificationAcknowledged: true,
      verificationNote: "Independent administrator verification completed.",
    }, {
      env,
      repository: {
        getNormalizedCommand: vi.fn(async () => normalizedCreate),
        getMutationCandidate: vi.fn(async () => mutationCandidate),
        reconcile,
      } as unknown as ServiceNowWriteRepository,
      adapter: adapter({ readBack }),
    })).rejects.toMatchObject({
      status: 409,
      code: "SERVICENOW_WRITE_MUTATION_CANDIDATE_CONFLICT",
    });
    expect(readBack).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("requires explicit duplicate-risk acknowledgment before marking a create candidate not applied", async () => {
    const reconcile = vi.fn(async () => ({
      command_id: "command-id-0000000001",
      command_status: "retry_scheduled" as const,
      command_version: 2,
      reconciliation_result: "confirmed_not_applied",
    }));
    const readBack = vi.fn(async () => ({
      result: "not_found" as const,
      summary: { method: "correlation_marker", matchCount: 0 },
    }));
    const repository = {
      getNormalizedCommand: vi.fn(async () => normalizedCreate),
      getMutationCandidate: vi.fn(async () => mutationCandidate),
      reconcile,
      getCommand: vi.fn(async () => commandSummary({
        status: "retry_scheduled",
        version: 2,
      })),
    } as unknown as ServiceNowWriteRepository;
    const input = {
      commandId: "command-id-0000000001",
      action: "mark_not_applied_after_verification" as const,
      session,
      requestId: "request-create-candidate-not-applied",
      correlationId: "request-create-candidate-not-applied",
      confirmation,
      verificationAcknowledged: true as const,
      verificationNote: "Exact marker review found no current ServiceNow row.",
    };
    await expect(reconcileCommand(input, {
      env,
      repository,
      adapter: adapter({ readBack }),
    })).rejects.toMatchObject({
      code: "SERVICENOW_WRITE_MUTATION_CANDIDATE_RISK_ACK_REQUIRED",
    });
    expect(readBack).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();

    await reconcileCommand({
      ...input,
      mutationCandidateRiskAcknowledged: true,
    }, {
      env,
      repository,
      adapter: adapter({ readBack }),
      audit: async () => auditFixture,
    });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      result: "confirmed_not_applied",
      mutationCandidateRiskAcknowledged: true,
      safeReadBackSummary: expect.objectContaining({
        evidenceClassification: "provider_not_found",
        mutationCandidateRiskAcknowledged: true,
      }),
    }));
  });

  it("rejects provider-unavailable manual success when no mutation candidate was recorded", async () => {
    const reconcile = vi.fn();
    await expect(reconcileCommand({
      commandId: "command-id-0000000001",
      action: "mark_succeeded_after_verification",
      session,
      requestId: "request-manual-unavailable-no-candidate",
      correlationId: "request-manual-unavailable-no-candidate",
      confirmation,
      verifiedTargetSysId: "b".repeat(32),
      verifiedTargetNumber: "INC0010004",
      verificationAcknowledged: true,
      verificationNote: "Independent administrator verification completed.",
    }, {
      env: {
        DATA_BACKEND: "supabase-relational",
        SESSION_SECRET: "0123456789abcdef0123456789abcdef",
        SERVICENOW_ENABLED: "true",
        SERVICENOW_AUTH_MODE: "basic",
      },
      repository: {
        getNormalizedCommand: vi.fn(async () => normalizedCreate),
        getMutationCandidate: vi.fn(async () => undefined),
        reconcile,
      } as unknown as ServiceNowWriteRepository,
    })).rejects.toMatchObject({
      status: 409,
      code: "SERVICENOW_WRITE_MUTATION_CANDIDATE_CONFLICT",
    });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each([
    ["confirmed_succeeded" as const, "SERVICENOW_WRITE_PROVIDER_MATCHED"],
    ["ambiguous" as const, "SERVICENOW_WRITE_RECONCILIATION_AMBIGUOUS"],
    ["inconclusive" as const, "SERVICENOW_WRITE_PROVIDER_INCONCLUSIVE"],
  ])("blocks mark-not-applied when provider read-back is %s", async (providerResult, code) => {
    const reconcile = vi.fn();
    await expect(reconcileCommand({
      commandId: "command-id-0000000001",
      action: "mark_not_applied_after_verification",
      session,
      requestId: `request-not-applied-${providerResult}`,
      correlationId: `request-not-applied-${providerResult}`,
      confirmation,
      verificationAcknowledged: true,
      verificationNote: "Independent administrator verification completed.",
    }, {
      env,
      repository: {
        getNormalizedCommand: vi.fn(async () => normalizedUpdate),
        reconcile,
      } as unknown as ServiceNowWriteRepository,
      adapter: adapter({
        readBack: vi.fn(async () => ({
          result: providerResult,
          summary: { method: "exact_sys_id", matchCount: providerResult === "ambiguous" ? 2 : 1 },
          ...(providerResult === "confirmed_succeeded" ? {
            targetSysId: "b".repeat(32),
            targetNumber: "INC0010004",
          } : providerResult === "inconclusive" ? {
            targetSysId: "b".repeat(32),
            targetNumber: "INC0010004",
          } : {}),
        })),
      }),
    })).rejects.toMatchObject({ code });
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("records an explicit journal not-applied decision without provider mutation", async () => {
    const providerExecute = vi.fn();
    const providerReadBack = vi.fn();
    const reconcile = vi.fn(async () => ({
      command_id: "command-id-0000000001",
      command_status: "retry_scheduled" as const,
      command_version: 2,
      reconciliation_result: "confirmed_not_applied",
    }));
    await reconcileCommand({
      commandId: "command-id-0000000001",
      action: "mark_not_applied_after_verification",
      session,
      requestId: "request-journal-not-applied",
      correlationId: "request-journal-not-applied",
      confirmation,
      verificationAcknowledged: true,
      duplicateJournalRiskAcknowledged: true,
      verificationNote: "Independent journal review completed.",
    }, {
      env,
      repository: {
        getNormalizedCommand: vi.fn(async () => ({
          schemaVersion: "servicenow-write-normalized-v2",
          commandType: "add_comment",
          targetSysId: "b".repeat(32),
          fields: { comments: "Reviewed comment" },
        })),
        reconcile,
        getCommand: vi.fn(async () => commandSummary({
          commandType: "add_comment",
          status: "retry_scheduled",
          version: 2,
        })),
      } as unknown as ServiceNowWriteRepository,
      adapter: { ...adapter(), execute: providerExecute, readBack: providerReadBack },
      audit: async () => auditFixture,
    });
    expect(providerExecute).not.toHaveBeenCalled();
    expect(providerReadBack).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      safeReadBackSummary: expect.objectContaining({
        evidenceClassification: "journal_manual_verification",
        duplicateJournalRiskAcknowledged: true,
        providerResult: "journal_presence_not_safely_provable",
      }),
    }));
  });

  it("rejects journal not-applied review without duplicate-risk acknowledgment", async () => {
    const reconcile = vi.fn();
    const providerReadBack = vi.fn();
    await expect(reconcileCommand({
      commandId: "command-id-0000000001",
      action: "mark_not_applied_after_verification",
      session,
      requestId: "request-journal-missing-risk-ack",
      correlationId: "request-journal-missing-risk-ack",
      confirmation,
      verificationAcknowledged: true,
      verificationNote: "Independent journal review completed.",
    }, {
      env,
      repository: {
        getNormalizedCommand: vi.fn(async () => ({
          schemaVersion: "servicenow-write-normalized-v2",
          commandType: "add_work_note",
          targetSysId: "b".repeat(32),
          fields: { work_notes: "Reviewed note" },
        })),
        reconcile,
      } as unknown as ServiceNowWriteRepository,
      adapter: adapter({ readBack: providerReadBack }),
    })).rejects.toMatchObject({
      code: "SERVICENOW_WRITE_DUPLICATE_JOURNAL_ACK_REQUIRED",
    });
    expect(providerReadBack).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("maps a defensive non-create target continuity conflict to a safe response", async () => {
    await expect(reconcileCommand({
      commandId: "command-id-0000000001",
      action: "mark_succeeded_after_verification",
      session,
      requestId: "request-service-reconcile-storage-conflict",
      correlationId: "request-service-reconcile-storage-conflict",
      confirmation,
      verifiedTargetSysId: "b".repeat(32),
      verifiedTargetNumber: "INC0010004",
      verificationAcknowledged: true,
      verificationNote: "Verified by exact Incident read-back.",
    }, {
      env,
      repository: {
        getNormalizedCommand: vi.fn(async () => ({
          schemaVersion: "servicenow-write-normalized-v2",
          commandType: "add_work_note",
          targetSysId: "b".repeat(32),
          fields: { work_notes: "Reviewed note" },
        })),
        reconcile: vi.fn(async () => {
          throw new Error("SERVICENOW_WRITE_TARGET_CONTINUITY_CONFLICT");
        }),
      } as unknown as ServiceNowWriteRepository,
      adapter: adapter({
        readBack: vi.fn(async () => ({
          result: "confirmed_succeeded",
          summary: { method: "exact_target", matchCount: 1 },
          targetSysId: "b".repeat(32),
          targetNumber: "INC0010004",
        })),
      }),
    })).rejects.toMatchObject({
      status: 409,
      code: "SERVICENOW_WRITE_TARGET_CONTINUITY_CONFLICT",
    });
  });

  it("does not turn an authoritative result into failure when secondary audit fails", async () => {
    const repository = {
      beginAttempt: vi.fn(async () => begin(normalizedCreate, 0)),
      finishAttempt: vi.fn(async () => ({
        command_id: "command-id-0000000001",
        command_status: "dry_run_ready",
        command_attempt_count: 0,
        command_version: 2,
      })),
      getCommand: vi.fn(async () => commandSummary({ status: "dry_run_ready", version: 2 })),
    } as unknown as ServiceNowWriteRepository;
    const result = await executeCommandDryRun({
      commandId: "command-id-0000000001",
      session,
      requestId: "request-service-0007",
      correlationId: "request-service-0007",
    }, {
      env,
      repository,
      adapter: adapter(),
      audit: async () => { throw new Error("audit unavailable"); },
      createId: () => "attempt-id-0000000005",
    });
    expect(result).toMatchObject({ status: "dry_run_ready", auditWarning: "secondary_audit_write_failed" });
  });

  it("allows a GET readiness test while live mutation remains disabled", async () => {
    const disabledEnv = { ...env, SERVICENOW_WRITE_ENABLED: "false" };
    expect(getServiceNowWriteReadiness(disabledEnv)).toMatchObject({
      configured: true,
      relationalStorage: true,
      connectionTestable: true,
      connectionTested: false,
      liveWriteEnabled: false,
      liveWriteReady: false,
    });
    const testReadiness = vi.fn(async () => ({ connected: true, httpStatus: 200 }));
    const result = await testServiceNowWriteReadiness({
      correlationId: "request-service-0008",
      session,
    }, {
      env: disabledEnv,
      repository: {
        ensureConnection: vi.fn(async () => "connection"),
        recordReadinessProof: vi.fn(async (payload) => ({
          connection_id: "connection",
          configuration_fingerprint: payload.configurationFingerprint,
          tested_at: payload.testedAt,
          expires_at: payload.expiresAt,
          test_status: payload.testStatus,
          safe_http_status: payload.safeHttpStatus,
          safe_error_code: null,
        })),
      } as unknown as ServiceNowWriteRepository,
      adapter: adapter({ testReadiness }),
      now: () => new Date("2026-07-23T01:00:00.000Z"),
    });
    expect(testReadiness).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      connectionTested: true,
      connectionTestable: true,
      liveWriteEnabled: false,
      liveWriteReady: false,
    });
  });

  it("keeps ledger reads and confirmation available without provider credentials", async () => {
    const unavailableEnv = {
      DATA_BACKEND: "supabase-relational",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef",
      SERVICENOW_ENABLED: "true",
      SERVICENOW_AUTH_MODE: "basic",
    };
    const detail = commandSummary({ status: "reconciliation_required" });
    const repository = {
      getCommand: vi.fn(async () => detail),
      listCommands: vi.fn(async () => ({ commands: [detail], total: 1 })),
      issueConfirmation: vi.fn(async () => ({
        command_id: detail.id,
        command_version: detail.version,
        normalized_payload_hash: detail.normalizedPayloadHash,
        confirmation_expires_at: "2026-07-23T01:07:00.000Z",
      })),
      getOperationsSummary: vi.fn(async () => ({
        countsByStatus: { reconciliation_required: 1 },
      })),
    } as unknown as ServiceNowWriteRepository;
    await expect(getCommandStatus(detail.id, {
      env: unavailableEnv,
      repository,
    })).resolves.toBe(detail);
    await expect(listCommands({ page: 1, limit: 20 }, {
      env: unavailableEnv,
      repository,
    })).resolves.toMatchObject({ total: 1 });
    await expect(getServiceNowWriteOperationsSummary({
      env: unavailableEnv,
      repository,
    })).resolves.toMatchObject({
      readiness: { configured: false, relationalStorage: true },
      countsByStatus: { reconciliation_required: 1 },
    });
    await expect(issueCommandConfirmation({
      commandId: detail.id,
      action: "mark_succeeded_after_verification",
      expectedVersion: detail.version,
      expectedNormalizedPayloadHash: detail.normalizedPayloadHash,
      session,
    }, {
      env: unavailableEnv,
      repository,
      createNonce: () => "provider-independent-confirmation-nonce",
      now: () => new Date("2026-07-23T01:05:00.000Z"),
    })).resolves.toMatchObject({
      commandId: detail.id,
      action: "mark_succeeded_after_verification",
    });
    await expect(issueManualOperation({
      commandType: "create_incident",
      sourceType: "manual",
      session,
    }, {
      env: unavailableEnv,
      repository,
      now: () => new Date("2026-07-23T01:05:00.000Z"),
    })).resolves.toMatchObject({
      operationReference: expect.stringMatching(/^manual-op:/),
    });
  });

  it("persists bounded read-back failure and permits explicit manual recovery without provider config", async () => {
    const unavailableEnv = {
      DATA_BACKEND: "supabase-relational",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef",
      SERVICENOW_ENABLED: "true",
      SERVICENOW_AUTH_MODE: "basic",
    };
    const reconcile = vi.fn(async (payload) => ({
      command_id: payload.commandId,
      command_status: payload.action === "reconcile_by_read_back"
        ? "reconciliation_required" as const
        : "succeeded" as const,
      command_version: 2,
      reconciliation_result: payload.result,
    }));
    const repository = {
      getNormalizedCommand: vi.fn(async () => normalizedCreate),
      getMutationCandidate: vi.fn(async () => mutationCandidate),
      reconcile,
      getCommand: vi.fn(async () => commandSummary({
        status: "reconciliation_required",
        version: 2,
      })),
    } as unknown as ServiceNowWriteRepository;
    await reconcileCommand({
      commandId: "command-id-0000000001",
      action: "reconcile_by_read_back",
      session,
      requestId: "request-ledger-recovery-read",
      correlationId: "request-ledger-recovery-read",
      confirmation,
    }, {
      env: unavailableEnv,
      repository,
      audit: async () => auditFixture,
      now: () => new Date("2026-07-23T01:06:00.000Z"),
    });
    expect(reconcile).toHaveBeenLastCalledWith(expect.objectContaining({
      result: "read_back_failed",
      safeReadBackSummary: expect.objectContaining({
        evidenceClassification: "provider_unavailable",
        errorCode: "SERVICENOW_CONFIGURATION_INVALID",
      }),
    }));

    await reconcileCommand({
      commandId: "command-id-0000000001",
      action: "mark_succeeded_after_verification",
      session,
      requestId: "request-ledger-recovery-manual",
      correlationId: "request-ledger-recovery-manual",
      confirmation,
      verifiedTargetSysId: "b".repeat(32),
      verifiedTargetNumber: "INC0010004",
      verificationAcknowledged: true,
      verificationNote: "Independent administrator verification completed.",
    }, {
      env: unavailableEnv,
      repository,
      audit: async () => auditFixture,
      now: () => new Date("2026-07-23T01:06:30.000Z"),
    });
    expect(reconcile).toHaveBeenLastCalledWith(expect.objectContaining({
      result: "confirmed_succeeded",
      safeReadBackSummary: expect.objectContaining({
        evidenceClassification: "provider_unavailable_manual_verification",
      }),
    }));
  });

  it("blocks execute and retry before touching the ledger when provider config is invalid", async () => {
    const unavailableEnv = {
      DATA_BACKEND: "supabase-relational",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef",
      SERVICENOW_ENABLED: "true",
      SERVICENOW_AUTH_MODE: "basic",
    };
    const beginAttempt = vi.fn();
    const dependencies = {
      env: unavailableEnv,
      repository: { beginAttempt } as unknown as ServiceNowWriteRepository,
    };
    const input = {
      commandId: "command-id-0000000001",
      session,
      requestId: "request-provider-blocked",
      correlationId: "request-provider-blocked",
      confirmation,
    };
    await expect(executeCommand(input, dependencies)).rejects.toMatchObject({
      code: "SERVICENOW_CONFIGURATION_INVALID",
    });
    await expect(retryCommand(input, dependencies)).rejects.toMatchObject({
      code: "SERVICENOW_CONFIGURATION_INVALID",
    });
    expect(beginAttempt).not.toHaveBeenCalled();
  });

  it("allows manual success on bounded provider unavailability but blocks provider not-found", async () => {
    const reconcile = vi.fn(async () => ({
      command_id: "command-id-0000000001",
      command_status: "succeeded" as const,
      command_version: 2,
      reconciliation_result: "confirmed_succeeded",
    }));
    const repository = {
      getNormalizedCommand: vi.fn(async () => normalizedCreate),
      getMutationCandidate: vi.fn(async () => mutationCandidate),
      reconcile,
      getCommand: vi.fn(async () => commandSummary({ status: "succeeded", version: 2 })),
    } as unknown as ServiceNowWriteRepository;
    const input = {
      commandId: "command-id-0000000001",
      action: "mark_succeeded_after_verification" as const,
      session,
      requestId: "request-provider-manual-success",
      correlationId: "request-provider-manual-success",
      confirmation,
      verifiedTargetSysId: "b".repeat(32),
      verifiedTargetNumber: "INC0010004",
      verificationAcknowledged: true as const,
      verificationNote: "Independent administrator verification completed.",
    };
    const unavailable = serviceNowError({
      category: "unavailable",
      code: "SERVICENOW_WRITE_NETWORK_UNAVAILABLE",
      safeMessage: "ServiceNow is unavailable",
      retryable: true,
      operation: "ticket.update",
      correlationId: correlationIdSchema.parse(input.correlationId),
    });
    await expect(reconcileCommand(input, {
      env,
      repository,
      adapter: adapter({ readBack: vi.fn(async () => { throw unavailable; }) }),
      audit: async () => auditFixture,
    })).resolves.toMatchObject({ status: "succeeded" });
    expect(reconcile).toHaveBeenLastCalledWith(expect.objectContaining({
      safeReadBackSummary: expect.objectContaining({
        evidenceClassification: "provider_unavailable_manual_verification",
      }),
    }));

    await expect(reconcileCommand({
      ...input,
      requestId: "request-provider-not-found",
      correlationId: "request-provider-not-found",
    }, {
      env,
      repository,
      adapter: adapter({
        readBack: vi.fn(async () => ({
          result: "not_found" as const,
          summary: { method: "correlation_marker", matchCount: 0 },
        })),
      }),
    })).rejects.toMatchObject({
      code: "SERVICENOW_WRITE_PROVIDER_NOT_FOUND",
    });
  });
});
