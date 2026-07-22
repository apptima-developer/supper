import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";
import { GET as live } from "./app/api/health/live/route";
import { GET as ready } from "./app/api/health/ready/route";

function request(path: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`https://app.example.test${path}`, init);
}

describe("proxy request ordering", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps production liveness public without APP_ORIGIN or runtime dependencies", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");

    expect((await proxy(request("/api/health/live"))).status).toBe(200);
    expect(live().status).toBe(200);
  });

  it("allows readiness to return sanitized 503 checks instead of a proxy 403", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("SESSION_SECRET", "");

    expect((await proxy(request("/api/health/ready"))).status).toBe(200);
    const response = ready();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe("not_ready");
    expect(JSON.stringify(body)).not.toContain("SUPABASE_SERVICE_ROLE_KEY=");
  });

  it("does not evaluate invalid APP_ORIGIN for safe reads", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", "not-an-origin");

    expect((await proxy(request("/login", { method: "GET" }))).status).toBe(200);
    expect((await proxy(request("/dashboard", { method: "GET" }))).status).toBe(307);
  });

  it("accepts the configured mutation origin and rejects missing or mismatched origins", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", "https://app.example.test");

    expect((await proxy(request("/api/auth/login", {
      method: "POST",
      headers: { origin: "https://app.example.test" },
    }))).status).toBe(200);
    expect((await proxy(request("/api/tickets", { method: "POST" }))).status).toBe(403);
    expect((await proxy(request("/api/tickets", {
      method: "POST",
      headers: { origin: "https://other.example.test" },
    }))).status).toBe(403);
  });

  it("keeps the login mutation behind Origin validation", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", "https://app.example.test");

    const response = await proxy(request("/api/auth/login", { method: "POST" }));
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(response.headers.get("x-request-id")).toBe(body.requestId);
    expect(body.requestId).toMatch(/^[A-Za-z0-9._-]{8,100}$/);
  });
});
