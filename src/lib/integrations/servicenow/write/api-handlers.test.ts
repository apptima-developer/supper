import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { Session } from "../../../auth";
import {
  handleServiceNowWriteCommandDetailGet,
  handleServiceNowWriteCommandDryRunPost,
  handleServiceNowWriteCommandExecutePost,
  handleServiceNowWriteCommandsGet,
  handleServiceNowWriteCommandsPost,
  handleServiceNowWriteConfirmationPost,
  handleServiceNowWriteManualOperationPost,
  handleServiceNowWriteReadinessPost,
  handleServiceNowWriteReconciliationPost,
} from "./api-handlers";
import type { ServiceNowWriteRepository } from "./repository";
import type { ServiceNowWriteCommandSummary } from "./types";

const admin: Session = { userId: "admin-id", username: "admin", name: "Admin", role: "admin", authVersion: 1 };
const support: Session = { userId: "support-id", username: "support", name: "Support", role: "support", authVersion: 1 };
const repository = {} as ServiceNowWriteRepository;
const hash = "a".repeat(64);
const commandId = "command-id-0000000001";
const operationToken = "a".repeat(120);

function summary(overrides: Partial<ServiceNowWriteCommandSummary> = {}): ServiceNowWriteCommandSummary {
  return {
    id: commandId,
    version: 1,
    commandType: "create_incident",
    status: "validated",
    sourceType: "manual",
    operationReference: "manual-op:command-id-0000000001",
    targetTable: "incident",
    commandMaterialHash: hash,
    normalizedPayloadHash: hash,
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

function confirmationBody(action?: string) {
  return {
    ...(action ? { action } : {}),
    confirmed: true,
    expectedVersion: 1,
    expectedNormalizedPayloadHash: hash,
    confirmationNonce: "nonce-value-with-sufficient-entropy",
  };
}

describe("ServiceNow write API security", () => {
  it("issues a protected bounded manual operation identity", async () => {
    const issueManualOperation = vi.fn(async () => ({
      operationToken,
      operationReference: `manual-op:${"b".repeat(64)}`,
      expiresAt: "2026-07-23T01:05:00.000Z",
    }));
    const response = await handleServiceNowWriteManualOperationPost(
      new Request("https://app.test/api/integrations/servicenow/write/manual-operation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandType: "create_incident",
          sourceType: "manual",
          sourceEntityReference: "draft:100",
        }),
      }),
      { getSession: async () => admin, issueManualOperation },
    );
    expect(response.status).toBe(201);
    expect(issueManualOperation).toHaveBeenCalledWith(expect.objectContaining({
      commandType: "create_incident",
      sourceType: "manual",
      sourceEntityReference: "draft:100",
      session: admin,
    }));
  });

  it("rejects unauthenticated and non-admin users", async () => {
    const unauthenticated = await handleServiceNowWriteCommandsGet(
      new Request("https://app.test/api/integrations/servicenow/write/commands"),
      { getSession: async () => null, repository },
    );
    const unauthorized = await handleServiceNowWriteCommandsGet(
      new Request("https://app.test/api/integrations/servicenow/write/commands"),
      { getSession: async () => support, repository },
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthorized.status).toBe(403);
  });

  it("accepts only strict bounded command bodies", async () => {
    const create = vi.fn(async () => summary());
    const valid = await handleServiceNowWriteCommandsPost(new Request(
      "https://app.test/api/integrations/servicenow/write/commands",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandType: "create_incident",
          sourceType: "manual",
          manualOperationToken: operationToken,
          payload: { shortDescription: "Short", description: "Description" },
        }),
      },
    ), { getSession: async () => admin, repository, create });
    const arbitrary = await handleServiceNowWriteCommandsPost(new Request(
      "https://app.test/api/integrations/servicenow/write/commands",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandType: "create_incident",
          sourceType: "manual",
          manualOperationToken: operationToken,
          payload: { shortDescription: "Short", description: "Description", authorization: "forbidden" },
        }),
      },
    ), { getSession: async () => admin, repository, create });
    expect(valid.status).toBe(201);
    expect(arbitrary.status).toBe(400);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("returns browser-safe command details without raw payload or credentials", async () => {
    const detail = vi.fn(async () => summary({
      safeRequestSummary: { method: "POST", fieldNames: ["description"] },
    }));
    const response = await handleServiceNowWriteCommandDetailGet(
      new Request(`https://app.test/api/integrations/servicenow/write/commands/${commandId}`),
      commandId,
      { getSession: async () => admin, repository, detail },
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("payload");
    expect(body).not.toHaveProperty("normalizedPayload");
    expect(JSON.stringify(body)).not.toMatch(/authorization|password|credential/i);
  });

  it("requires a strict one-time confirmation body for live execution", async () => {
    const execute = vi.fn(async () => summary({ status: "succeeded" }));
    const missing = await handleServiceNowWriteCommandExecutePost(
      new Request(`https://app.test/api/integrations/servicenow/write/commands/${commandId}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
      commandId,
      { getSession: async () => admin, repository, execute },
    );
    const valid = await handleServiceNowWriteCommandExecutePost(
      new Request(`https://app.test/api/integrations/servicenow/write/commands/${commandId}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(confirmationBody()),
      }),
      commandId,
      { getSession: async () => admin, repository, execute },
    );
    expect(missing.status).toBe(400);
    expect(valid.status).toBe(200);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ confirmation: confirmationBody() }),
      { repository },
    );
  });

  it("issues confirmations and requires an explicit reconciliation action", async () => {
    const issueConfirmation = vi.fn(async () => ({
      confirmationNonce: "nonce-value-with-sufficient-entropy",
      action: "execute" as const,
      commandId,
      expectedVersion: 1,
      expectedNormalizedPayloadHash: hash,
      expiresAt: "2026-07-23T01:02:00.000Z",
    }));
    const issued = await handleServiceNowWriteConfirmationPost(
      new Request(`https://app.test/api/integrations/servicenow/write/commands/${commandId}/confirmation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "execute",
          expectedVersion: 1,
          expectedNormalizedPayloadHash: hash,
        }),
      }),
      commandId,
      { getSession: async () => admin, repository, issueConfirmation },
    );
    const reconcile = vi.fn(async () => summary({ status: "succeeded" }));
    const reconciled = await handleServiceNowWriteReconciliationPost(
      new Request(`https://app.test/api/integrations/servicenow/write/commands/${commandId}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...confirmationBody("mark_succeeded_after_verification"),
          verifiedTargetSysId: "b".repeat(32),
          verifiedTargetNumber: "INC0010001",
          verificationAcknowledged: true,
          verificationNote: "Verified by exact Incident target.",
        }),
      }),
      commandId,
      { getSession: async () => admin, repository, reconcile },
    );
    expect(issued.status).toBe(201);
    expect(reconciled.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "mark_succeeded_after_verification",
        verifiedTargetSysId: "b".repeat(32),
        verifiedTargetNumber: "INC0010001",
        verificationAcknowledged: true,
        confirmation: expect.objectContaining({ confirmed: true, expectedVersion: 1 }),
      }),
      { repository },
    );
  });

  it("forwards the explicit duplicate-journal-risk acknowledgment", async () => {
    const reconcile = vi.fn(async () => summary({ status: "retry_scheduled" }));
    const response = await handleServiceNowWriteReconciliationPost(
      new Request(`https://app.test/api/integrations/servicenow/write/commands/${commandId}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...confirmationBody("mark_not_applied_after_verification"),
          verificationAcknowledged: true,
          duplicateJournalRiskAcknowledged: true,
          verificationNote: "Independent journal review completed.",
        }),
      }),
      commandId,
      { getSession: async () => admin, repository, reconcile },
    );
    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "mark_not_applied_after_verification",
        verificationAcknowledged: true,
        duplicateJournalRiskAcknowledged: true,
      }),
      { repository },
    );
  });

  it("rejects bodies on dry-run and readiness routes", async () => {
    const dryRun = vi.fn();
    const readiness = vi.fn();
    const actionResponse = await handleServiceNowWriteCommandDryRunPost(
      new Request(`https://app.test/api/integrations/servicenow/write/commands/${commandId}/dry-run`, {
        method: "POST",
        body: "x",
      }),
      commandId,
      { getSession: async () => admin, repository, dryRun },
    );
    const readinessResponse = await handleServiceNowWriteReadinessPost(
      new Request("https://app.test/api/integrations/servicenow/write/readiness", { method: "POST", body: "x" }),
      { getSession: async () => admin, repository, readiness },
    );
    expect(actionResponse.status).toBe(400);
    expect(readinessResponse.status).toBe(400);
    expect(dryRun).not.toHaveBeenCalled();
    expect(readiness).not.toHaveBeenCalled();
  });

  it("enforces bounded list filters and rejects provider query injection", async () => {
    const list = vi.fn(async () => ({ items: [], total: 0, page: 1, limit: 100 }));
    const valid = await handleServiceNowWriteCommandsGet(
      new Request("https://app.test/api/integrations/servicenow/write/commands?limit=100&status=reconciliation_required&commandType=update_incident"),
      { getSession: async () => admin, repository, list },
    );
    const invalid = await handleServiceNowWriteCommandsGet(
      new Request("https://app.test/api/integrations/servicenow/write/commands?sysparm_query=unsafe"),
      { getSession: async () => admin, repository, list },
    );
    expect(valid.status).toBe(200);
    expect(invalid.status).toBe(400);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
