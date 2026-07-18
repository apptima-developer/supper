import { beforeEach, describe, expect, it, vi } from "vitest";
import { maximumLoginBodyBytes } from "@/lib/request-security";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  createSession: vi.fn(),
  check: vi.fn(),
  recordFailure: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  authenticate: mocks.authenticate,
  createSession: mocks.createSession,
}));

vi.mock("@/lib/login-rate-limit", () => ({
  clientNetworkIdentifier: () => "network",
  createLoginRateLimitKey: () => "rate-limit-key",
  getLoginRateLimitStore: () => ({
    check: mocks.check,
    recordFailure: mocks.recordFailure,
    reset: mocks.reset,
  }),
}));

import { POST } from "./route";

const contentType = { "content-type": "application/x-www-form-urlencoded" };

function loginRequest(body: string, headers: Record<string, string> = contentType) {
  return new Request("https://app.example.test/api/auth/login", { method: "POST", headers, body });
}

describe("login route body boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue(null);
    mocks.createSession.mockResolvedValue(undefined);
    mocks.check.mockResolvedValue({ limited: false, retryAfterSeconds: 0 });
    mocks.recordFailure.mockResolvedValue({ limited: false, retryAfterSeconds: 0 });
    mocks.reset.mockResolvedValue(undefined);
  });

  it("accepts a valid URL-encoded form", async () => {
    mocks.authenticate.mockResolvedValue({
      userId: "user-1",
      username: "operator",
      name: "Operator",
      role: "support",
      authVersion: 1,
    });
    const response = await POST(loginRequest("username=operator&password=correct-horse"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://app.example.test/dashboard");
    expect(response.headers.get("x-request-id")).toMatch(/^[A-Za-z0-9._-]{8,100}$/);
    expect(mocks.authenticate).toHaveBeenCalledWith("operator", "correct-horse");
  });

  it("accepts the exact limit and rejects one byte above it", async () => {
    expect((await POST(loginRequest("x".repeat(maximumLoginBodyBytes)))).status).toBe(303);
    expect((await POST(loginRequest("x".repeat(maximumLoginBodyBytes + 1)))).status).toBe(413);
  });

  it("rejects oversized actual bytes without or despite a small Content-Length", async () => {
    const oversized = "x".repeat(maximumLoginBodyBytes + 1);
    expect((await POST(loginRequest(oversized))).status).toBe(413);
    expect((await POST(loginRequest(oversized, { ...contentType, "content-length": "1" }))).status).toBe(413);
  });

  it("rejects unsupported and malformed form media", async () => {
    expect((await POST(loginRequest("username=operator", { "content-type": "multipart/form-data" }))).status).toBe(415);
    expect((await POST(loginRequest("username=%ZZ&password=value"))).status).toBe(400);
  });

  it("keeps absent passwords and invalid credentials on the generic failure path", async () => {
    const missing = await POST(loginRequest("username=operator"));
    expect(missing.status).toBe(303);
    expect(missing.headers.get("location")).toBe("https://app.example.test/login?error=1");
    expect(missing.headers.get("x-request-id")).toMatch(/^[A-Za-z0-9._-]{8,100}$/);
    expect(mocks.authenticate).toHaveBeenCalledWith("operator", "");

    const invalid = await POST(loginRequest("username=operator&password=wrong"));
    expect(invalid.status).toBe(303);
    expect(invalid.headers.get("location")).toBe("https://app.example.test/login?error=1");
  });
});
