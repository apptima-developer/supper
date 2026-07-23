import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { Session } from "../../../auth";
import {
  handleServiceNowWriteCommandDetailGet,
  handleServiceNowWriteCommandDryRunPost,
  handleServiceNowWriteCommandsGet,
  handleServiceNowWriteCommandsPost,
  handleServiceNowWriteReadinessPost,
} from "./api-handlers";
import type { ServiceNowWriteRepository } from "./repository";

const admin: Session = { userId: "admin-id", username: "admin", name: "Admin", role: "admin", authVersion: 1 };
const support: Session = { userId: "support-id", username: "support", name: "Support", role: "support", authVersion: 1 };
const repository = {} as ServiceNowWriteRepository;

describe("ServiceNow write API security", () => {
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
    const create = vi.fn(async () => ({
      id: "command-id-0000000001",
      commandType: "create_incident" as const,
      status: "validated" as const,
      sourceType: "manual" as const,
      sourceReference: "manual:api-test",
      targetTable: "incident",
      validationSummary: { valid: true },
      safeRequestSummary: {},
      safeResponseSummary: {},
      attemptCount: 0,
      maxAttempts: 3,
      createdBy: "admin-id",
      createdAt: "2026-07-23T01:00:00.000Z",
      updatedAt: "2026-07-23T01:00:00.000Z",
    }));
    const valid = await handleServiceNowWriteCommandsPost(new Request(
      "https://app.test/api/integrations/servicenow/write/commands",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandType: "create_incident",
          sourceType: "manual",
          sourceReference: "manual:api-test",
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
          sourceReference: "manual:api-test",
          payload: { shortDescription: "Short", description: "Description", authorization: "forbidden" },
        }),
      },
    ), { getSession: async () => admin, repository, create });
    expect(valid.status).toBe(201);
    expect(arbitrary.status).toBe(400);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("returns browser-safe command details without raw payload or credentials", async () => {
    const detail = vi.fn(async () => ({
      id: "command-id-0000000001",
      commandType: "create_incident" as const,
      status: "validated" as const,
      sourceType: "manual" as const,
      sourceReference: "manual:api-test",
      targetTable: "incident",
      validationSummary: { valid: true },
      safeRequestSummary: { method: "POST", fieldNames: ["description"] },
      safeResponseSummary: {},
      attemptCount: 0,
      maxAttempts: 3,
      createdBy: "admin-id",
      createdAt: "2026-07-23T01:00:00.000Z",
      updatedAt: "2026-07-23T01:00:00.000Z",
    }));
    const response = await handleServiceNowWriteCommandDetailGet(
      new Request("https://app.test/api/integrations/servicenow/write/commands/command-id-0000000001"),
      "command-id-0000000001",
      { getSession: async () => admin, repository, detail },
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("payload");
    expect(body).not.toHaveProperty("normalizedPayload");
    expect(JSON.stringify(body)).not.toMatch(/authorization|password|credential/i);
  });

  it("rejects bodies on action and readiness routes", async () => {
    const dryRun = vi.fn();
    const readiness = vi.fn();
    const actionResponse = await handleServiceNowWriteCommandDryRunPost(
      new Request("https://app.test/api/integrations/servicenow/write/commands/command-id-0000000001/dry-run", {
        method: "POST",
        body: "x",
      }),
      "command-id-0000000001",
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
      new Request("https://app.test/api/integrations/servicenow/write/commands?limit=100&status=failed&commandType=update_incident"),
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
