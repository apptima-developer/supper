import { describe, expect, it, vi } from "vitest";
import { correlationIdSchema } from "../../schemas";
import type { ServiceNowEnabledConfig } from "../config";
import { ServiceNowWriteAdapter } from "./adapter";

const config: ServiceNowEnabledConfig = {
  enabled: true,
  authMode: "basic",
  username: "unit-test-user",
  password: "unit-test-placeholder",
  instanceUrl: "https://example.service-now.com",
  timeoutMs: 5_000,
  pageSize: 25,
  incidentTable: "incident",
};
const correlationId = correlationIdSchema.parse("request-write-adapter-0001");

function providerResponse(status: number, result: unknown) {
  return new Response(JSON.stringify({ result }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ServiceNow write adapter", () => {
  it("creates an Incident with a bounded POST and extracts only safe response fields", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
      void _input;
      void _init;
      return providerResponse(201, {
        sys_id: "a".repeat(32),
        number: "INC0010001",
        state: "1",
        description: "raw provider value that must not be summarized",
      });
    });
    const adapter = new ServiceNowWriteAdapter(config, { fetch: fetchMock as typeof fetch });
    const result = await adapter.execute({
      commandType: "create_incident",
      fields: { short_description: "Short", description: "Description" },
    }, correlationId);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/now/table/incident");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ short_description: "Short", description: "Description" });
    expect(result.responseSummary).toEqual({
      httpStatus: 201,
      sysId: "a".repeat(32),
      number: "INC0010001",
      state: "1",
    });
    expect(JSON.stringify(result)).not.toContain("raw provider value");
  });

  it("resolves an Incident number before PATCH", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
      void _input;
      void _init;
      return providerResponse(500, {});
    })
      .mockResolvedValueOnce(providerResponse(200, [{ sys_id: "b".repeat(32), number: "INC0010002" }]))
      .mockResolvedValueOnce(providerResponse(200, { sys_id: "b".repeat(32), number: "INC0010002", state: "2" }));
    const adapter = new ServiceNowWriteAdapter(config, { fetch: fetchMock as typeof fetch });
    const result = await adapter.execute({
      commandType: "update_incident",
      targetNumber: "INC0010002",
      fields: { state: "2" },
    }, correlationId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("sysparm_query=number%3DINC0010002");
    expect(String(fetchMock.mock.calls[1][0])).toContain(`/incident/${"b".repeat(32)}`);
    expect(fetchMock.mock.calls[1][1]?.method).toBe("PATCH");
    expect(result.targetSysId).toBe("b".repeat(32));
  });

  it("maps bounded provider failures without exposing response bodies", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
      void _input;
      void _init;
      return new Response(JSON.stringify({ error: { message: "raw internal detail" } }), { status: 429 });
    });
    const adapter = new ServiceNowWriteAdapter(config, { fetch: fetchMock as typeof fetch });
    await expect(adapter.execute({
      commandType: "add_work_note",
      targetSysId: "c".repeat(32),
      fields: { work_notes: "Note" },
    }, correlationId)).rejects.toMatchObject({
      code: "SERVICENOW_WRITE_RATE_LIMITED",
      safeMessage: "ServiceNow temporarily rate limited the write request",
      retryable: true,
    });
  });

  it("rejects an oversized success response", async () => {
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) => {
      void _input;
      void _init;
      return new Response(JSON.stringify({ result: { value: "x".repeat(70_000) } }), { status: 200 });
    });
    const adapter = new ServiceNowWriteAdapter(config, { fetch: fetchMock as typeof fetch });
    await expect(adapter.execute({
      commandType: "update_incident",
      targetSysId: "d".repeat(32),
      fields: { state: "2" },
    }, correlationId)).rejects.toMatchObject({ code: "SERVICENOW_WRITE_RESPONSE_TOO_LARGE" });
  });
});
