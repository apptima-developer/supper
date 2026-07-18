import { describe, expect, it } from "vitest";
import { normalizeBaseUrl, runSmokeTest, validateLiveResponse, validateReadyResponse } from "./smoke-test.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": body.requestId || "request_123456",
    },
  });
}

describe("operational smoke-test validation", () => {
  it("requires and normalizes an explicit safe base URL", () => {
    expect(() => normalizeBaseUrl("")).toThrow(/required/);
    expect(() => normalizeBaseUrl("ftp://example.test")).toThrow(/HTTP or HTTPS/);
    expect(() => normalizeBaseUrl("https://user:pass@example.test")).toThrow(/without credentials/);
    expect(normalizeBaseUrl("https://example.test/path?q=1")).toBe("https://example.test");
  });

  it("validates correlated live and ready responses", async () => {
    await expect(validateLiveResponse(jsonResponse({ application: "SUPPER Support Control System", status: "live", version: "0.1.0", requestId: "request_123456" })))
      .resolves.toMatchObject({ status: "PASS" });
    await expect(validateReadyResponse(jsonResponse({ application: "SUPPER Support Control System", status: "ready", backend: "local-json", requestId: "request_123456" }), "local-json"))
      .resolves.toMatchObject({ status: "PASS" });
    await expect(validateReadyResponse(jsonResponse({ application: "SUPPER Support Control System", status: "not_ready", backend: "local-json", requestId: "request_123456" }, 503)))
      .resolves.toMatchObject({ status: "FAIL" });
  });

  it("runs only the three read-only endpoints and reports failures safely", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method, redirect: init.redirect });
      if (url.endsWith("/api/health/live")) return jsonResponse({ application: "SUPPER Support Control System", status: "live", version: "0.1.0", requestId: "request_123456" });
      if (url.endsWith("/api/health/ready")) return jsonResponse({ application: "SUPPER Support Control System", status: "ready", backend: "local-json", requestId: "request_123456" });
      return new Response("<!doctype html><title>Login</title>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    };
    const results = await runSmokeTest({ baseUrl: "http://localhost:3000", expectedBackend: "local-json", fetchImpl });
    expect(results.every((item) => item.status === "PASS")).toBe(true);
    expect(calls).toEqual([
      { url: "http://localhost:3000/api/health/live", method: "GET", redirect: "manual" },
      { url: "http://localhost:3000/api/health/ready", method: "GET", redirect: "manual" },
      { url: "http://localhost:3000/login", method: "GET", redirect: "manual" },
    ]);
  });
});
