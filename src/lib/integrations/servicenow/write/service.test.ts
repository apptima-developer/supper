import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { Session } from "../../../auth";
import type { Audit } from "../../../types";
import { correlationIdSchema } from "../../schemas";
import { serviceNowError } from "../errors";
import { serviceNowDefaultWriteMapping } from "./normalization";
import type { ServiceNowWriteRepository } from "./repository";
import { createCommand, executeCommand, executeCommandDryRun } from "./service";
import type { ServiceNowWriteCommandSummary } from "./types";

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
    commandType: "create_incident",
    status: "validated",
    sourceType: "manual",
    sourceReference: "manual:service-test",
    targetTable: "incident",
    validationSummary: { valid: true },
    safeRequestSummary: {},
    safeResponseSummary: {},
    attemptCount: 0,
    maxAttempts: 3,
    createdBy: "admin-id",
    createdAt: "2026-07-23T01:00:00.000Z",
    updatedAt: "2026-07-23T01:00:00.000Z",
    ...overrides,
  };
}

describe("ServiceNow write service", () => {
  it("validates and normalizes before one idempotent persistence call", async () => {
    const createStored = vi.fn(async () => ({
      action: "created" as const,
      command_id: "command-id-0000000001",
      command_status: "validated" as const,
      command_attempt_count: 0,
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
      sourceType: "manual",
      sourceReference: "manual:service-test",
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
      commandType: "create_incident",
      payload: expect.objectContaining({ description: "Description" }),
      normalizedPayload: expect.objectContaining({
        fields: expect.objectContaining({ short_description: "Short", description: "Description", impact: "2" }),
      }),
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      normalizedPayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      entity: "servicenow-write-command",
      details: expect.not.objectContaining({ payload: expect.anything() }),
    }));
  });

  it("records a dry-run attempt without invoking provider execution", async () => {
    const executeProvider = vi.fn();
    const finishAttempt = vi.fn(async () => ({
      command_id: "command-id-0000000001",
      command_status: "dry_run_ready" as const,
      command_attempt_count: 0,
    }));
    const repository = {
      beginAttempt: vi.fn(async () => ({
        attempt_number: 1,
        command_type: "create_incident" as const,
        normalized_payload: {
          commandType: "create_incident" as const,
          fields: { short_description: "Short", description: "Description" },
        },
        target_table: "incident",
        target_sys_id: null,
        target_number: null,
        max_attempts: 3,
        live_attempt_count: 0,
      })),
      finishAttempt,
      getCommand: vi.fn(async () => commandSummary({ status: "dry_run_ready" })),
    } as unknown as ServiceNowWriteRepository;
    const result = await executeCommandDryRun({
      commandId: "command-id-0000000001",
      session,
      requestId: "request-service-0002",
      correlationId: "request-service-0002",
    }, {
      env,
      repository,
      adapter: {
        preview: () => ({ method: "POST", endpointPath: "/api/now/table/incident", targetTable: "incident", fieldNames: ["description", "short_description"] }),
        execute: executeProvider,
        testReadiness: vi.fn(),
      },
      audit: async () => auditFixture,
      now: () => new Date("2026-07-23T01:01:00.000Z"),
      createId: () => "attempt-id-0000000001",
    });
    expect(result.status).toBe("dry_run_ready");
    expect(executeProvider).not.toHaveBeenCalled();
    expect(finishAttempt).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "dry_run",
      responseSummary: { validated: true, providerWritePerformed: false },
    }));
  });

  it("persists a successful live attempt and safe target identity", async () => {
    const finishAttempt = vi.fn(async () => ({
      command_id: "command-id-0000000001",
      command_status: "succeeded" as const,
      command_attempt_count: 1,
      command_target_sys_id: "a".repeat(32),
      command_target_number: "INC0010001",
    }));
    const repository = {
      beginAttempt: vi.fn(async () => ({
        attempt_number: 1,
        command_type: "create_incident" as const,
        normalized_payload: { commandType: "create_incident" as const, fields: { short_description: "Short" } },
        target_table: "incident",
        target_sys_id: null,
        target_number: null,
        max_attempts: 3,
        live_attempt_count: 1,
      })),
      finishAttempt,
      getCommand: vi.fn(async () => commandSummary({
        status: "succeeded",
        attemptCount: 1,
        targetSysId: "a".repeat(32),
        targetNumber: "INC0010001",
      })),
    } as unknown as ServiceNowWriteRepository;
    const result = await executeCommand({
      commandId: "command-id-0000000001",
      session,
      requestId: "request-service-0003",
      correlationId: "request-service-0003",
    }, {
      env,
      repository,
      adapter: {
        preview: () => ({ method: "POST", endpointPath: "/api/now/table/incident", targetTable: "incident", fieldNames: ["short_description"] }),
        execute: vi.fn(async () => ({
          requestSummary: { method: "POST" as const, endpointPath: "/api/now/table/incident", targetTable: "incident", fieldNames: ["short_description"] },
          responseSummary: { httpStatus: 201, sysId: "a".repeat(32), number: "INC0010001" },
          targetSysId: "a".repeat(32),
          targetNumber: "INC0010001",
        })),
        testReadiness: vi.fn(),
      },
      audit: async () => auditFixture,
      now: () => new Date("2026-07-23T01:02:00.000Z"),
      createId: () => "attempt-id-0000000002",
    });
    expect(result).toMatchObject({ status: "succeeded", targetNumber: "INC0010001" });
    expect(finishAttempt).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "succeeded",
      targetSysId: "a".repeat(32),
      targetNumber: "INC0010001",
      responseSummary: expect.not.objectContaining({ raw: expect.anything() }),
    }));
  });

  it("classifies a retryable failure and schedules a bounded retry", async () => {
    const finishAttempt = vi.fn(async () => ({
      command_id: "command-id-0000000001",
      command_status: "retry_scheduled" as const,
      command_attempt_count: 1,
      command_next_retry_at: "2026-07-23T01:03:30.000Z",
    }));
    const repository = {
      beginAttempt: vi.fn(async () => ({
        attempt_number: 1,
        command_type: "update_incident" as const,
        normalized_payload: {
          commandType: "update_incident" as const,
          targetSysId: "b".repeat(32),
          fields: { state: "2" },
        },
        target_table: "incident",
        target_sys_id: "b".repeat(32),
        target_number: null,
        max_attempts: 3,
        live_attempt_count: 1,
      })),
      finishAttempt,
      getCommand: vi.fn(async () => commandSummary({
        commandType: "update_incident",
        status: "retry_scheduled",
        attemptCount: 1,
        nextRetryAt: "2026-07-23T01:03:30.000Z",
        errorCode: "SERVICENOW_WRITE_TIMEOUT",
        errorMessage: "ServiceNow write timed out",
      })),
    } as unknown as ServiceNowWriteRepository;
    const providerError = serviceNowError({
      category: "timeout",
      code: "SERVICENOW_WRITE_TIMEOUT",
      safeMessage: "ServiceNow write timed out",
      retryable: true,
      operation: "ticket.update",
      correlationId: correlationIdSchema.parse("request-service-0004"),
    });
    const result = await executeCommand({
      commandId: "command-id-0000000001",
      session,
      requestId: "request-service-0004",
      correlationId: "request-service-0004",
    }, {
      env,
      repository,
      adapter: {
        preview: () => ({ method: "PATCH", endpointPath: `/api/now/table/incident/${"b".repeat(32)}`, targetTable: "incident", fieldNames: ["state"] }),
        execute: vi.fn(async () => { throw providerError; }),
        testReadiness: vi.fn(),
      },
      audit: async () => auditFixture,
      now: () => new Date("2026-07-23T01:03:00.000Z"),
      createId: () => "attempt-id-0000000003",
    });
    expect(result.status).toBe("retry_scheduled");
    expect(finishAttempt).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      retryable: true,
      errorCode: "SERVICENOW_WRITE_TIMEOUT",
      errorMessage: "ServiceNow write timed out",
      nextRetryAt: "2026-07-23T01:03:30.000Z",
    }));
  });

  it("does not turn an authoritative command outcome into failure when secondary audit fails", async () => {
    const repository = {
      beginAttempt: vi.fn(async () => ({
        attempt_number: 1,
        command_type: "create_incident" as const,
        normalized_payload: { commandType: "create_incident" as const, fields: { short_description: "Short" } },
        target_table: "incident",
        target_sys_id: null,
        target_number: null,
        max_attempts: 3,
        live_attempt_count: 0,
      })),
      finishAttempt: vi.fn(async () => ({ command_id: "command-id-0000000001", command_status: "dry_run_ready", command_attempt_count: 0 })),
      getCommand: vi.fn(async () => commandSummary({ status: "dry_run_ready" })),
    } as unknown as ServiceNowWriteRepository;
    const result = await executeCommandDryRun({
      commandId: "command-id-0000000001",
      session,
      requestId: "request-service-0005",
      correlationId: "request-service-0005",
    }, {
      env,
      repository,
      adapter: {
        preview: () => ({ method: "POST", endpointPath: "/api/now/table/incident", targetTable: "incident", fieldNames: ["short_description"] }),
        execute: vi.fn(),
        testReadiness: vi.fn(),
      },
      audit: async () => { throw new Error("audit unavailable"); },
      createId: () => "attempt-id-0000000004",
    });
    expect(result).toMatchObject({ status: "dry_run_ready", auditWarning: "secondary_audit_write_failed" });
  });
});
