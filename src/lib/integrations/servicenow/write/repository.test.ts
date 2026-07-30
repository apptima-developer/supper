import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { safeServiceNowWriteCommand } from "./repository";

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
