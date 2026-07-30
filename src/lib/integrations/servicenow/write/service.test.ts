import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { Session } from "../../../auth";
import type { Audit } from "../../../types";
import { correlationIdSchema } from "../../schemas";
import { serviceNowError } from "../errors";
import { serviceNowDefaultWriteMapping } from "./normalization";
import { serviceNowWriteExecutionError } from "./outcomes";
import type { ServiceNowWriteRepository } from "./repository";
import {
  createCommand,
  executeCommand,
  executeCommandDryRun,
  issueCommandConfirmation,
  getServiceNowWriteReadiness,
  reconcileCommand,
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

describe("ServiceNow write service", () => {
  it("validates and submits raw command material once while SQL owns normalized identity", async () => {
    const createStored = vi.fn(async () => ({
      action: "created" as const,
      command_id: "command-id-0000000001",
      command_status: "validated" as const,
      command_attempt_count: 0,
      command_version: 1,
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
    }));
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
    const reconcile = vi.fn(async () => ({
      command_id: "command-id-0000000001",
      command_status: "succeeded" as const,
      command_version: 2,
      reconciliation_result: "confirmed_succeeded",
    }));
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
      safeReadBackSummary: { method: "correlation_marker", matchCount: 1 },
      confirmationNonceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
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
    }, {
      env: disabledEnv,
      repository: {} as ServiceNowWriteRepository,
      adapter: adapter({ testReadiness }),
    });
    expect(testReadiness).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      connectionTested: true,
      connectionTestable: true,
      liveWriteEnabled: false,
      liveWriteReady: false,
    });
  });
});
