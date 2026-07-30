import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { Session } from "../../../auth";
import {
  issueManualOperationIdentity,
  resolveManualOperationIdentity,
} from "./manual-operation";

const env = {
  NODE_ENV: "test",
  APP_ENV: "ai-development",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
};
const admin: Session = {
  userId: "admin-id",
  username: "admin",
  name: "Admin",
  role: "admin",
  authVersion: 1,
};
const otherAdmin: Session = { ...admin, userId: "other-admin-id", username: "other" };

describe("ServiceNow manual operation identity", () => {
  it("issues one stable operation reference reusable after a lost HTTP response", async () => {
    const now = () => new Date("2026-07-23T01:00:00.000Z");
    let value = 0;
    const identity = await issueManualOperationIdentity({
      session: admin,
      commandType: "create_incident",
      sourceEntityReference: "draft:100",
    }, {
      env,
      now,
      randomHex: () => (++value).toString(16).padStart(64, "0"),
    });
    const first = await resolveManualOperationIdentity({
      operationToken: identity.operationToken,
      session: admin,
      commandType: "create_incident",
      sourceEntityReference: "draft:100",
    }, { env, now });
    const replay = await resolveManualOperationIdentity({
      operationToken: identity.operationToken,
      session: admin,
      commandType: "create_incident",
      sourceEntityReference: "draft:100",
    }, { env, now });
    expect(first.operationReference).toBe(identity.operationReference);
    expect(replay).toEqual(first);
  });

  it("rejects user, command, source-context, environment, and expiry mismatches", async () => {
    const issuedAt = () => new Date("2026-07-23T01:00:00.000Z");
    const identity = await issueManualOperationIdentity({
      session: admin,
      commandType: "create_incident",
      sourceEntityReference: "draft:100",
    }, {
      env,
      now: issuedAt,
      randomHex: () => "a".repeat(64),
    });
    const base = {
      operationToken: identity.operationToken,
      session: admin,
      commandType: "create_incident" as const,
      sourceEntityReference: "draft:100",
    };
    await expect(resolveManualOperationIdentity(
      { ...base, session: otherAdmin },
      { env, now: issuedAt },
    )).rejects.toMatchObject({ code: "SERVICENOW_WRITE_MANUAL_OPERATION_INVALID" });
    await expect(resolveManualOperationIdentity(
      { ...base, commandType: "update_incident" },
      { env, now: issuedAt },
    )).rejects.toMatchObject({ code: "SERVICENOW_WRITE_MANUAL_OPERATION_INVALID" });
    await expect(resolveManualOperationIdentity(
      { ...base, sourceEntityReference: "draft:changed" },
      { env, now: issuedAt },
    )).rejects.toMatchObject({ code: "SERVICENOW_WRITE_MANUAL_OPERATION_INVALID" });
    await expect(resolveManualOperationIdentity(
      base,
      { env: { ...env, APP_ENV: "different" }, now: issuedAt },
    )).rejects.toMatchObject({ code: "SERVICENOW_WRITE_MANUAL_OPERATION_INVALID" });
    await expect(resolveManualOperationIdentity(
      base,
      { env, now: () => new Date("2026-07-23T01:06:00.000Z") },
    )).rejects.toMatchObject({ code: "SERVICENOW_WRITE_MANUAL_OPERATION_INVALID" });
  });
});
