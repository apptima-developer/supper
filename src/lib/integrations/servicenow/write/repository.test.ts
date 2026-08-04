import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import {
  currentServiceNowMutationCandidate,
  latestTerminalCandidateResolutions,
  safeServiceNowWriteCommand,
} from "./repository";
import type {
  ServiceNowWriteMutationCandidate,
  ServiceNowWriteReconciliationEventSummary,
} from "./types";

const validRow = {
  id: "command-id-0000000001",
  version: 1,
  command_type: "create_incident",
  status: "validated",
  source_type: "manual",
  source_entity_reference: null,
  operation_reference: "manual-op:command-id-0000000001",
  target_table: "incident",
  target_sys_id: null,
  target_number: null,
  command_material_hash: "b".repeat(64),
  normalized_payload_hash: "a".repeat(64),
  provider_correlation_marker: `SUPPER:${"b".repeat(64)}`,
  normalized_payload: {
    schemaVersion: "servicenow-write-normalized-v2",
    commandType: "create_incident",
    providerCorrelationMarker: `SUPPER:${"b".repeat(64)}`,
    fields: {
      correlation_id: `SUPPER:${"b".repeat(64)}`,
      short_description: "Short",
      description: "Description",
    },
  },
  validation_summary: {
    valid: true,
    mappedFieldCount: 3,
    mappedFields: ["correlation_id", "description", "short_description"],
    warningCodes: [],
  },
  safe_request_summary: {},
  safe_response_summary: {},
  delivery_disposition: null,
  failure_phase: null,
  retry_allowed: false,
  retry_reason: null,
  reconciliation_reason: null,
  reconciliation_checked_at: null,
  reconciled_by_user_id: null,
  reconciliation_result: null,
  error_code: null,
  error_message: null,
  attempt_count: 0,
  max_attempts: 3,
  next_retry_at: null,
  last_attempt_at: null,
  completed_at: null,
  created_by: "admin-id",
  created_at: "2026-07-23T01:00:00.000Z",
  updated_at: "2026-07-23T01:00:00.000Z",
};

describe("ServiceNow write persisted row parsing", () => {
  it("returns only the strict browser-safe command projection", () => {
    const result = safeServiceNowWriteCommand(validRow, { includePreview: true });
    expect(result).toMatchObject({
      id: "command-id-0000000001",
      version: 1,
      operationReference: "manual-op:command-id-0000000001",
      retryAllowed: false,
    });
    expect(result).not.toHaveProperty("normalized_payload");
    expect(JSON.stringify(result.normalizedPreview)).not.toContain("Description");
  });

  it("rejects unknown columns and malformed normalized payloads with a bounded integrity error", () => {
    expect(() => safeServiceNowWriteCommand({ ...validRow, raw_provider_response: {} }))
      .toThrow(/integrity validation/i);
    expect(() => safeServiceNowWriteCommand({
      ...validRow,
      normalized_payload: {
        ...validRow.normalized_payload,
        targetSysId: "not-a-sys-id",
      },
    }, { includePreview: true })).toThrow(/integrity validation/i);
  });

  it("rejects sensitive keys embedded in persisted safe summaries", () => {
    expect(() => safeServiceNowWriteCommand({
      ...validRow,
      safe_response_summary: { accessToken: "forbidden" },
    })).toThrow(/integrity validation/i);
  });
});

describe("ServiceNow mutation Candidate projection", () => {
  const candidateId = `sn-candidate-${"c".repeat(64)}`;
  const event = (
    id: string,
    result: ServiceNowWriteReconciliationEventSummary["result"],
    createdAt: string,
  ): ServiceNowWriteReconciliationEventSummary => ({
    id,
    mutationCandidateEventId: candidateId,
    action: "reconcile_by_read_back",
    result,
    evidenceClassification: "provider_inconclusive",
    safeReadBackSummary: { evidenceClassification: "provider_inconclusive" },
    actorUserId: "admin-id",
    commandVersionBefore: 2,
    commandVersionAfter: 3,
    createdAt,
  });

  it("keeps the newest terminal resolution when older or nonterminal history follows", () => {
    const newestTerminal = event("terminal-new", "confirmed_not_applied", "2026-08-04T03:00:00.000Z");
    const resolutions = latestTerminalCandidateResolutions([
      event("inconclusive-newer", "inconclusive", "2026-08-04T04:00:00.000Z"),
      newestTerminal,
      event("terminal-old", "confirmed_succeeded", "2026-08-04T02:00:00.000Z"),
      event("not-found-old", "not_found", "2026-08-04T01:00:00.000Z"),
    ]);
    expect(resolutions.get(candidateId)).toBe(newestTerminal);
  });

  it("returns Candidate B after resolved Candidate A", () => {
    const candidate = (id: string, resolutionState: ServiceNowWriteMutationCandidate["resolutionState"]): ServiceNowWriteMutationCandidate => ({
      id,
      attemptId: `attempt-${id.slice(-8)}`,
      attemptNumber: resolutionState === "current_unresolved" ? 2 : 1,
      sysId: "d".repeat(32),
      number: resolutionState === "current_unresolved" ? "INC0000002" : "INC0000001",
      httpStatus: 201,
      observedAt: "2026-08-04T03:00:00.000Z",
      source: "mutation_response",
      proofStatus: "marker_not_verified",
      resolutionState,
    });
    const candidateA = candidate(`sn-candidate-${"a".repeat(64)}`, "confirmed_not_applied");
    const candidateB = candidate(`sn-candidate-${"b".repeat(64)}`, "current_unresolved");
    expect(currentServiceNowMutationCandidate([candidateA, candidateB])).toBe(candidateB);
  });
});
