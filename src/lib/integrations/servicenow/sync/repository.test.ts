import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MappedServiceNowIncident } from "./mapping";

const rpc = vi.fn();

vi.mock("server-only", () => ({}));
vi.mock("../../../supabaseAdmin", () => ({ supabaseAdmin: { rpc } }));

const mapped = {
  externalUpdatedAt: "2026-07-20T02:00:00.000Z",
  sourceHash: "a".repeat(64),
  linkMetadata: { requiresCustomerMapping: true, mappingWarnings: [] },
  ticket: {
    id: "generated-ticket-id",
    issueId: "INC0010001",
    issueType: "Incident",
    serviceNow: {
      externalSysId: "b".repeat(32),
      externalNumber: "INC0010001",
      externalUrl: "https://dev.example.service-now.com/incident",
    },
  },
} as unknown as MappedServiceNowIncident;

describe("ServiceNow reconciliation repository parity", () => {
  beforeEach(() => rpc.mockReset());

  it.each([
    ["created", null, undefined],
    ["updated", "ADOPTED_EXISTING_TICKET", "ADOPTED_EXISTING_TICKET"],
    ["unchanged", null, undefined],
    ["stale", null, undefined],
  ] as const)("uses the same RPC decision for preview and committed %s", async (outcome, warning, expectedWarning) => {
    rpc.mockResolvedValue({ data: [{ outcome, ticket_id: "historical-ticket-id", warning_code: warning }], error: null });
    const { ServiceNowSyncRepository } = await import("./repository");
    const repository = new ServiceNowSyncRepository();
    await expect(repository.preview(mapped)).resolves.toMatchObject({ outcome, ticketId: "historical-ticket-id", warningCode: expectedWarning });
    await expect(repository.upsert(mapped)).resolves.toMatchObject({ outcome, ticketId: "historical-ticket-id", warningCode: expectedWarning });
    expect(rpc).toHaveBeenCalledTimes(2);
    const previewPayload = rpc.mock.calls[0][1].p_payload;
    const committedPayload = rpc.mock.calls[1][1].p_payload;
    expect(previewPayload).toMatchObject({ dryRun: true, externalNumber: "INC0010001" });
    expect(committedPayload).toMatchObject({ dryRun: false, externalNumber: "INC0010001" });
    expect({ ...previewPayload, dryRun: false, linkId: "same" }).toEqual({ ...committedPayload, linkId: "same" });
  });

  it("returns the same bounded conflict for preview and commit without exposing provider data", async () => {
    rpc.mockResolvedValue({ data: [{ outcome: "failed", ticket_id: null, warning_code: "SERVICENOW_EXTERNAL_NUMBER_CONFLICT" }], error: null });
    const { ServiceNowSyncRepository } = await import("./repository");
    const repository = new ServiceNowSyncRepository();
    await expect(repository.preview(mapped)).resolves.toMatchObject({ outcome: "failed", safeErrorCode: "SERVICENOW_EXTERNAL_NUMBER_CONFLICT" });
    await expect(repository.upsert(mapped)).resolves.toMatchObject({ outcome: "failed", safeErrorCode: "SERVICENOW_EXTERNAL_NUMBER_CONFLICT" });
  });
});
