import { describe, expect, it } from "vitest";
import { serviceNowRecoveryAvailability } from "./recovery";
import type { ServiceNowWriteCommandSummary } from "./types";

function executingCommand(recoverableAt: string): ServiceNowWriteCommandSummary {
  return {
    id: "command-recovery-test",
    version: 2,
    commandType: "create_incident",
    status: "executing",
    sourceType: "manual",
    operationReference: "manual-op:recovery-test",
    targetTable: "incident",
    commandMaterialHash: "a".repeat(64),
    normalizedPayloadHash: "b".repeat(64),
    validationSummary: {},
    safeRequestSummary: {},
    safeResponseSummary: {},
    retryAllowed: false,
    attemptCount: 1,
    maxAttempts: 3,
    createdBy: "admin-id",
    createdAt: "2026-08-04T02:00:00.000Z",
    updatedAt: "2026-08-04T02:00:00.000Z",
    attempts: [{
      id: "attempt-recovery-test",
      attemptNumber: 1,
      executionMode: "live",
      requestSummary: {},
      responseSummary: {},
      outcome: "executing",
      retryAllowed: false,
      startedAt: "2026-08-04T02:00:00.000Z",
      attemptStartedAt: "2026-08-04T02:00:00.000Z",
      recoverableAt,
      providerRequestBudget: 3,
      recoveryBudgetMs: 135_000,
      recoveryEligible: false,
    }],
  };
}

describe("ServiceNow recovery availability", () => {
  it("keeps recovery unavailable one second before the lease", () => {
    const command = executingCommand("2026-08-04T02:03:00.000Z");
    expect(serviceNowRecoveryAvailability(command, Date.parse("2026-08-04T02:02:59.000Z")))
      .toMatchObject({ canRequestRecovery: false, remainingMilliseconds: 1_000 });
  });

  it("makes recovery reviewable at the lease timestamp", () => {
    const command = executingCommand("2026-08-04T02:03:00.000Z");
    expect(serviceNowRecoveryAvailability(command, Date.parse("2026-08-04T02:03:00.000Z")))
      .toMatchObject({ canRequestRecovery: true, remainingMilliseconds: 0 });
  });
});
