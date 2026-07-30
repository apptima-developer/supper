import { describe, expect, it, vi } from "vitest";
import { correlationIdSchema } from "../../schemas";
import type { ServiceNowEnabledConfig } from "../config";
import { ServiceNowWriteAdapter } from "./adapter";
import type { NormalizedServiceNowWriteCommand } from "./types";

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
const marker = `SUPPER:${"a".repeat(64)}`;
const createCommand: NormalizedServiceNowWriteCommand = {
  schemaVersion: "servicenow-write-normalized-v2",
  commandType: "create_incident",
  providerCorrelationMarker: marker,
  fields: {
    correlation_id: marker,
    short_description: "Short",
    description: "Description",
  },
};
const updateCommand: NormalizedServiceNowWriteCommand = {
  schemaVersion: "servicenow-write-normalized-v2",
  commandType: "update_incident",
  targetSysId: "d".repeat(32),
  fields: { state: "2" },
};

function providerResponse(status: number, result: unknown) {
  return new Response(JSON.stringify({ result }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ServiceNow write adapter", () => {
  it("checks the create marker before one bounded POST and extracts only safe response fields", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(providerResponse(200, []))
      .mockResolvedValueOnce(providerResponse(201, {
        sys_id: "a".repeat(32),
        number: "INC0010001",
        state: "1",
        description: "raw provider value that must not be summarized",
      }))
      .mockResolvedValueOnce(providerResponse(200, [{
        sys_id: "a".repeat(32),
        number: "INC0010001",
        state: "1",
        correlation_id: marker,
      }]));
    const adapter = new ServiceNowWriteAdapter(config, { fetch: fetchMock as typeof fetch });
    const result = await adapter.execute(createCommand, correlationId);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`sysparm_query=correlation_id%3D${encodeURIComponent(marker)}`);
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain("/api/now/table/incident");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(createCommand.fields);
    expect(result.responseSummary).toEqual({
      httpStatus: 201,
      sysId: "a".repeat(32),
      number: "INC0010001",
      state: "1",
      postWriteMarkerVerified: true,
      postWriteLookupHttpStatus: 200,
    });
    expect(String(fetchMock.mock.calls[2][0])).toContain(`sysparm_query=correlation_id%3D${encodeURIComponent(marker)}`);
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("raw provider value");
  });

  it("recovers one matching create marker without dispatching a POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse(200, [{
      sys_id: "b".repeat(32),
      number: "INC0010002",
      state: "2",
      correlation_id: marker,
    }]));
    const result = await new ServiceNowWriteAdapter(config, {
      fetch: fetchMock as typeof fetch,
    }).execute(createCommand, correlationId);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
    expect(result.responseSummary).toMatchObject({
      recoveredByCorrelationMarker: true,
      number: "INC0010002",
    });
  });

  it("requires reconciliation when a create marker matches multiple incidents", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse(200, [
      { sys_id: "b".repeat(32), number: "INC0010002", correlation_id: marker },
      { sys_id: "c".repeat(32), number: "INC0010003", correlation_id: marker },
    ]));
    await expect(new ServiceNowWriteAdapter(config, {
      fetch: fetchMock as typeof fetch,
    }).execute(createCommand, correlationId)).rejects.toMatchObject({
      code: "SERVICENOW_WRITE_CORRELATION_AMBIGUOUS",
      deliveryDisposition: "may_have_committed",
      failurePhase: "read_back",
      retryAllowed: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["zero marker records", []],
    ["a row missing the marker", [{
      sys_id: "a".repeat(32),
      number: "INC0010001",
    }]],
    ["a different marker", [{
      sys_id: "a".repeat(32),
      number: "INC0010001",
      correlation_id: `SUPPER:${"b".repeat(64)}`,
    }]],
    ["ambiguous marker records", [
      {
        sys_id: "a".repeat(32),
        number: "INC0010001",
        correlation_id: marker,
      },
      {
        sys_id: "b".repeat(32),
        number: "INC0010002",
        correlation_id: marker,
      },
    ]],
    ["a mismatched sys_id", [{
      sys_id: "b".repeat(32),
      number: "INC0010001",
      correlation_id: marker,
    }]],
    ["a mismatched number", [{
      sys_id: "a".repeat(32),
      number: "INC0099999",
      correlation_id: marker,
    }]],
  ])("keeps a create uncertain when post-write proof returns %s", async (_label, verificationRows) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(providerResponse(200, []))
      .mockResolvedValueOnce(providerResponse(201, {
        sys_id: "a".repeat(32),
        number: "INC0010001",
        state: "1",
      }))
      .mockResolvedValueOnce(providerResponse(200, verificationRows));
    await expect(new ServiceNowWriteAdapter(config, {
      fetch: fetchMock as typeof fetch,
    }).execute(createCommand, correlationId)).rejects.toMatchObject({
      deliveryDisposition: "may_have_committed",
      failurePhase: "read_back",
      retryAllowed: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });

  it("keeps a create uncertain when post-write marker verification times out", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(providerResponse(200, []))
        .mockResolvedValueOnce(providerResponse(201, {
          sys_id: "a".repeat(32),
          number: "INC0010001",
          state: "1",
        }))
        .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        }));
      const execution = new ServiceNowWriteAdapter(
        { ...config, timeoutMs: 10 },
        { fetch: fetchMock as typeof fetch },
      ).execute(createCommand, correlationId);
      const rejection = expect(execution).rejects.toMatchObject({
        code: "SERVICENOW_WRITE_TIMEOUT",
        deliveryDisposition: "may_have_committed",
        failurePhase: "read_back",
        retryAllowed: false,
      });
      await vi.advanceTimersByTimeAsync(11);
      await rejection;
      expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["HTTP 5xx", () => Promise.resolve(providerResponse(503, {}))],
    ["a malformed response", () => Promise.resolve(new Response("{", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))],
    ["a network failure", () => Promise.reject(new TypeError("network unavailable"))],
  ])("keeps a create uncertain when post-write proof has %s", async (_label, proofResponse) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(providerResponse(200, []))
      .mockResolvedValueOnce(providerResponse(201, {
        sys_id: "a".repeat(32),
        number: "INC0010001",
        state: "1",
      }))
      .mockImplementationOnce(proofResponse);
    await expect(new ServiceNowWriteAdapter(config, {
      fetch: fetchMock as typeof fetch,
    }).execute(createCommand, correlationId)).rejects.toMatchObject({
      deliveryDisposition: "may_have_committed",
      failurePhase: "read_back",
      retryAllowed: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  });

  it("resolves exactly one Incident number before PATCH", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(providerResponse(200, [{ sys_id: "b".repeat(32), number: "INC0010002" }]))
      .mockResolvedValueOnce(providerResponse(200, { sys_id: "b".repeat(32), number: "INC0010002", state: "2" }));
    const adapter = new ServiceNowWriteAdapter(config, { fetch: fetchMock as typeof fetch });
    const result = await adapter.execute({
      ...updateCommand,
      targetSysId: undefined,
      targetNumber: "INC0010002",
    }, correlationId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("sysparm_query=number%3DINC0010002");
    expect(String(fetchMock.mock.calls[1][0])).toContain(`/incident/${"b".repeat(32)}`);
    expect(fetchMock.mock.calls[1][1]?.method).toBe("PATCH");
    expect(result.targetSysId).toBe("b".repeat(32));
  });

  it("rejects a mismatched number lookup before PATCH", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse(200, [{
      sys_id: "b".repeat(32),
      number: "INC0099999",
    }]));
    await expect(new ServiceNowWriteAdapter(config, {
      fetch: fetchMock as typeof fetch,
    }).execute({
      ...updateCommand,
      targetSysId: undefined,
      targetNumber: "INC0010002",
    }, correlationId)).rejects.toMatchObject({
      code: "SERVICENOW_WRITE_LOOKUP_MISMATCH",
      deliveryDisposition: "definitely_not_sent",
      retryAllowed: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
  });

  it.each([
    ["missing", undefined],
    ["different", `SUPPER:${"b".repeat(64)}`],
  ])("rejects a %s correlation marker before POST", async (_label, returnedMarker) => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse(200, [{
      sys_id: "b".repeat(32),
      number: "INC0010002",
      ...(returnedMarker ? { correlation_id: returnedMarker } : {}),
    }]));
    await expect(new ServiceNowWriteAdapter(config, {
      fetch: fetchMock as typeof fetch,
    }).execute(createCommand, correlationId)).rejects.toMatchObject({
      code: "SERVICENOW_WRITE_LOOKUP_MISMATCH",
      deliveryDisposition: "definitely_not_sent",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
  });

  it("rejects a mismatched sys_id read-back", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse(200, {
      sys_id: "e".repeat(32),
      number: "INC0010005",
      state: "2",
    }));
    await expect(new ServiceNowWriteAdapter(config, {
      fetch: fetchMock as typeof fetch,
    }).readBack(updateCommand, correlationId)).rejects.toMatchObject({
      code: "SERVICENOW_WRITE_LOOKUP_MISMATCH",
      deliveryDisposition: "definitely_not_sent",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
  });

  it("rejects a mixed target pair returned by separate number and sys_id reads", async () => {
    const sysId = "b".repeat(32);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(providerResponse(200, [{
        sys_id: sysId,
        number: "INC0010002",
      }]))
      .mockResolvedValueOnce(providerResponse(200, {
        sys_id: sysId,
        number: "INC0099999",
        state: "2",
      }));
    await expect(new ServiceNowWriteAdapter(config, {
      fetch: fetchMock as typeof fetch,
    }).readBack({
      ...updateCommand,
      targetSysId: undefined,
      targetNumber: "INC0010002",
    }, correlationId)).rejects.toMatchObject({
      code: "SERVICENOW_WRITE_LOOKUP_MISMATCH",
      deliveryDisposition: "definitely_not_sent",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every((call) => call[1]?.method === "GET")).toBe(true);
  });

  it("rejects a mixed target pair returned by a direct sys_id read", async () => {
    const sysId = "b".repeat(32);
    const fetchMock = vi.fn().mockResolvedValue(providerResponse(200, {
      sys_id: sysId,
      number: "INC0099999",
      state: "2",
    }));
    await expect(new ServiceNowWriteAdapter(config, {
      fetch: fetchMock as typeof fetch,
    }).readBack({
      ...updateCommand,
      targetSysId: sysId,
      targetNumber: "INC0010002",
    }, correlationId)).rejects.toMatchObject({
      code: "SERVICENOW_WRITE_LOOKUP_MISMATCH",
      deliveryDisposition: "definitely_not_sent",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
  });

  it("treats a mismatched mutation response pair as uncertain and never retryable", async () => {
    const sysId = "b".repeat(32);
    const fetchMock = vi.fn().mockResolvedValue(providerResponse(200, {
      sys_id: sysId,
      number: "INC0099999",
      state: "2",
    }));
    await expect(new ServiceNowWriteAdapter(config, {
      fetch: fetchMock as typeof fetch,
    }).execute({
      ...updateCommand,
      targetSysId: sysId,
      targetNumber: "INC0010002",
    }, correlationId)).rejects.toMatchObject({
      code: "SERVICENOW_WRITE_LOOKUP_MISMATCH",
      deliveryDisposition: "may_have_committed",
      failurePhase: "response_parse",
      retryAllowed: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.method).toBe("PATCH");
  });

  it("keeps definitive rejection separate from retryable pre-commit responses", async () => {
    const rejectedFetch = vi.fn().mockResolvedValue(providerResponse(400, {}));
    await expect(new ServiceNowWriteAdapter(config, {
      fetch: rejectedFetch as typeof fetch,
    }).execute(updateCommand, correlationId)).rejects.toMatchObject({
      deliveryDisposition: "definitely_rejected",
      failurePhase: "mutation_response",
      retryAllowed: false,
    });

    const rateLimitedFetch = vi.fn().mockResolvedValue(providerResponse(429, {}));
    await expect(new ServiceNowWriteAdapter(config, {
      fetch: rateLimitedFetch as typeof fetch,
    }).execute(updateCommand, correlationId)).rejects.toMatchObject({
      code: "SERVICENOW_WRITE_RATE_LIMITED",
      deliveryDisposition: "safe_to_retry",
      failurePhase: "mutation_response",
      retryAllowed: true,
    });
  });

  it.each([
    ["provider 5xx", () => providerResponse(503, {})],
    ["malformed success", () => new Response("{", { status: 200 })],
    ["empty success", () => new Response(null, { status: 200 })],
    ["oversized success", () => providerResponse(200, { value: "x".repeat(70_000) })],
    ["invalid identity", () => providerResponse(200, { sys_id: "not-a-sys-id", number: "INC1" })],
  ])("classifies %s after mutation dispatch as may-have-committed", async (_label, response) => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    await expect(new ServiceNowWriteAdapter(config, {
      fetch: fetchMock as typeof fetch,
    }).execute(updateCommand, correlationId)).rejects.toMatchObject({
      deliveryDisposition: "may_have_committed",
      retryAllowed: false,
    });
  });

  it("classifies post-dispatch network and timeout failures as may-have-committed", async () => {
    const networkFetch = vi.fn().mockRejectedValue(new TypeError("network unavailable"));
    await expect(new ServiceNowWriteAdapter(config, {
      fetch: networkFetch as typeof fetch,
    }).execute(updateCommand, correlationId)).rejects.toMatchObject({
      code: "SERVICENOW_WRITE_NETWORK_UNAVAILABLE",
      deliveryDisposition: "may_have_committed",
      failurePhase: "mutation_dispatch",
      retryAllowed: false,
    });

    const timeoutFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      })
    ));
    await expect(new ServiceNowWriteAdapter({ ...config, timeoutMs: 1 }, {
      fetch: timeoutFetch as typeof fetch,
    }).execute(updateCommand, correlationId)).rejects.toMatchObject({
      code: "SERVICENOW_WRITE_TIMEOUT",
      deliveryDisposition: "may_have_committed",
      failurePhase: "mutation_dispatch",
      retryAllowed: false,
    });
  });

  it("classifies an abort after dispatch as may-have-committed", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        queueMicrotask(() => controller.abort());
      })
    ));
    await expect(new ServiceNowWriteAdapter(config, {
      fetch: fetchMock as typeof fetch,
    }).execute(updateCommand, correlationId, controller.signal)).rejects.toMatchObject({
      code: "SERVICENOW_WRITE_ABORTED",
      deliveryDisposition: "may_have_committed",
      retryAllowed: false,
    });
  });

  it.each([
    ["add_comment" as const, "comments"],
    ["add_work_note" as const, "work_notes"],
  ])("never treats an uncertain %s as retryable", async (commandType, field) => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network disconnected"));
    await expect(new ServiceNowWriteAdapter(config, {
      fetch: fetchMock as typeof fetch,
    }).execute({
      schemaVersion: "servicenow-write-normalized-v2",
      commandType,
      targetSysId: "e".repeat(32),
      fields: { [field]: "Journal content" },
    }, correlationId)).rejects.toMatchObject({
      deliveryDisposition: "may_have_committed",
      retryAllowed: false,
    });
  });

  it("stops at authorization failure without dispatching an Incident mutation", async () => {
    const oauthConfig: ServiceNowEnabledConfig = {
      enabled: true,
      authMode: "oauth_client_credentials",
      clientId: "unit-test-client",
      clientSecret: "unit-test-secret",
      instanceUrl: "https://example.service-now.com",
      timeoutMs: 5_000,
      pageSize: 25,
      incidentTable: "incident",
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(new ServiceNowWriteAdapter(oauthConfig, {
      fetch: fetchMock as typeof fetch,
    }).execute(updateCommand, correlationId)).rejects.toMatchObject({
      code: "SERVICENOW_OAUTH_FAILED",
      deliveryDisposition: "definitely_rejected",
      failurePhase: "authorization",
      retryAllowed: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("/oauth_token.do");
  });

  it("uses GET only for readiness", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse(200, [{
      sys_id: "f".repeat(32),
      number: "INC0010004",
    }]));
    await expect(new ServiceNowWriteAdapter(config, {
      fetch: fetchMock as typeof fetch,
    }).testReadiness(correlationId)).resolves.toEqual({ connected: true, httpStatus: 200 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
  });

  it("resolves journal target identity by GET without claiming journal success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(providerResponse(200, {
      sys_id: "f".repeat(32),
      number: "INC0010005",
    }));
    const result = await new ServiceNowWriteAdapter(config, {
      fetch: fetchMock as typeof fetch,
    }).readBack({
      schemaVersion: "servicenow-write-normalized-v2",
      commandType: "add_work_note",
      targetSysId: "f".repeat(32),
      fields: { work_notes: "Journal content" },
    }, correlationId);
    expect(result).toEqual({
      result: "inconclusive",
      summary: {
        method: "journal_manual_verification",
        journalField: "work_notes",
        targetIdentityResolved: true,
      },
      targetSysId: "f".repeat(32),
      targetNumber: "INC0010005",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
  });
});
