import { afterEach, describe, expect, it, vi } from "vitest";
import { backupTarget } from "./json-store";
import { restoreBackupAsAdmin } from "./backup-service";
import { dummyPasswordHash, genericAuthenticationFailure, sessionMatchesUser, validLoginUser } from "./auth-policy";
import { createLoginRateLimitKey, createMemoryLoginRateLimitStore, loginRateLimitStorageDescription } from "./login-rate-limit";
import { accountCreateSchema, accountUpdateSchema, customerCreateSchema, passwordSchema, ticketCreateSchema, ticketUserUpdateSchema } from "./mutation-schemas";
import { validateInlineImageDataUrl, validateSpreadsheetUpload } from "./request-limits";
import { assertContentLength, HttpError, isSameOriginRequest, readLimitedBodyBytes } from "./request-security";
import { buildSecurityHeaders } from "./security-headers";
import { redactSensitive } from "./server-logging";
import { toAdminUserDto } from "./user-dto";
import type { Session } from "./auth";
import type { User } from "./types";

const user: User = {
  id: "user-1",
  username: "operator",
  name: "Operator",
  email: "operator@example.test",
  passwordHash: "stored-hash",
  role: "support",
  active: true,
  authVersion: 3,
};
const session: Session = {
  userId: user.id,
  username: user.username,
  name: user.name,
  role: user.role,
  authVersion: user.authVersion,
};

const validTicket = {
  issueId: "INC-1",
  customerKey: "customer-1",
  issueTitle: "Example issue",
  issueType: "Incident",
  category: "Application",
  severity: "High",
  ownerEfforts: [{ owner: "Operator", hours: 1 }],
  status: "Open",
  startDate: "2026-07-17T09:00:00.000Z",
  closeDate: "",
  chargeable: true,
  logEntry: { message: "Investigating", attachments: [] },
};

describe("strict browser mutation schemas", () => {
  it("accepts valid ticket fields and rejects unknown or immutable fields", () => {
    expect(ticketCreateSchema.safeParse(validTicket).success).toBe(true);
    expect(ticketCreateSchema.safeParse({ ...validTicket, createdAt: "forged" }).success).toBe(false);
    expect(ticketUserUpdateSchema.safeParse({ id: "forged" }).success).toBe(false);
    expect(ticketUserUpdateSchema.safeParse({ issueId: "changed" }).success).toBe(false);
    expect(ticketUserUpdateSchema.safeParse({ ownerEfforts: [{ owner: "Operator", hours: -1 }] }).success).toBe(false);
  });

  it("rejects system-owned customer fields", () => {
    const customer = {
      year: 2026,
      projectCode: "PROJECT",
      customerName: "Example",
      contractType: "Support",
      contractStatus: "Active",
      mdPurchased: 10,
      carryForward: 0,
      mdRate: 1,
      startPeriod: "2026-01-01",
      endPeriod: "2026-12-31",
      renewalAlert: "",
      aeUpdate: "",
      active: true,
    };
    expect(customerCreateSchema.safeParse(customer).success).toBe(true);
    expect(customerCreateSchema.safeParse({ ...customer, mdUsed: 500 }).success).toBe(false);
  });

  it("rejects user security metadata and password hashes", () => {
    const account = { username: "operator", password: "long-enough-password", email: "operator@example.test", role: "support", active: true };
    expect(accountCreateSchema.safeParse(account).success).toBe(true);
    expect(accountCreateSchema.safeParse({ ...account, authVersion: 99 }).success).toBe(false);
    expect(accountUpdateSchema.safeParse({ ...account, passwordHash: "forged" }).success).toBe(false);
  });
});

describe("password and session policy", () => {
  it("enforces the new password policy without affecting stored hashes", () => {
    expect(passwordSchema.safeParse("long-enough-password").success).toBe(true);
    expect(passwordSchema.safeParse("short").success).toBe(false);
    expect(passwordSchema.safeParse("            ").success).toBe(false);
    expect(accountCreateSchema.safeParse({ username: "same-as-password", password: "same-as-password", email: "u@example.test", role: "support", active: true }).success).toBe(false);
  });

  it("uses generic login failure behavior for missing, disabled, and incorrect accounts", async () => {
    const compare = vi.fn(async (_password: string, hash: string) => hash === "stored-hash");
    expect(genericAuthenticationFailure).toBe("Authentication failed");
    await expect(validLoginUser(undefined, "wrong", compare)).resolves.toBeNull();
    expect(compare).toHaveBeenCalledWith("wrong", dummyPasswordHash);
    await expect(validLoginUser({ ...user, active: false }, "password", compare)).resolves.toBeNull();
    await expect(validLoginUser(user, "password", vi.fn(async () => false))).resolves.toBeNull();
  });

  it("rejects disabled users and stale session versions", () => {
    expect(sessionMatchesUser(session, user)).toBe(true);
    expect(sessionMatchesUser(session, { ...user, active: false })).toBe(false);
    expect(sessionMatchesUser(session, { ...user, authVersion: 4 })).toBe(false);
  });
});

describe("login rate limiting", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("locks the fifth failure and resets on success", async () => {
    const store = createMemoryLoginRateLimitStore();
    const key = createLoginRateLimitKey("Operator", "network", "test-pepper-that-is-at-least-32-characters");
    const now = new Date("2026-07-17T00:00:00.000Z");
    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect((await store.recordFailure(key, now)).limited).toBe(false);
    }
    const locked = await store.recordFailure(key, now);
    expect(locked.limited).toBe(true);
    expect(locked.retryAfterSeconds).toBe(900);
    await store.reset(key);
    expect((await store.check(key, now)).limited).toBe(false);
  });

  it("selects persistent storage for both Supabase backends without connecting", () => {
    vi.stubEnv("DATA_BACKEND", "supabase");
    expect(loginRateLimitStorageDescription()).toContain("persistent table");
    vi.stubEnv("DATA_BACKEND", "supabase-relational");
    expect(loginRateLimitStorageDescription()).toContain("persistent table");
  });
});

describe("same-origin and request limits", () => {
  it("accepts safe reads and the configured origin only", () => {
    const args = { requestUrl: "https://app.example.test/api/tickets", configuredOrigin: "https://app.example.test" };
    expect(isSameOriginRequest({ ...args, method: "GET", origin: null })).toBe(true);
    expect(isSameOriginRequest({ ...args, method: "POST", origin: "https://app.example.test" })).toBe(true);
    expect(isSameOriginRequest({ ...args, method: "POST", origin: "https://other.example.test" })).toBe(false);
    expect(isSameOriginRequest({ ...args, method: "POST", origin: null })).toBe(false);
    expect(isSameOriginRequest({ method: "POST", requestUrl: "http://localhost:3000/api", origin: "http://localhost:3000", configuredOrigin: null })).toBe(true);
  });

  it("enforces declared and streamed body boundaries", async () => {
    expect(() => assertContentLength(new Request("https://app.test", { headers: { "content-length": "4" } }), 4)).not.toThrow();
    expect(() => assertContentLength(new Request("https://app.test", { headers: { "content-length": "5" } }), 4)).toThrow(HttpError);
    await expect(readLimitedBodyBytes(new Request("https://app.test", { method: "POST", body: "1234" }), 4)).resolves.toHaveLength(4);
    await expect(readLimitedBodyBytes(new Request("https://app.test", { method: "POST", body: "12345" }), 4)).rejects.toMatchObject({ status: 413 });
  });
});

describe("upload validation", () => {
  const xlsx = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngDataUrl = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;

  it("checks workbook extension, MIME, signature, and exact size", () => {
    expect(() => validateSpreadsheetUpload({ fileName: "input.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: xlsx, maxBytes: 5 })).not.toThrow();
    expect(() => validateSpreadsheetUpload({ fileName: "input.xlsx", contentType: "application/octet-stream", buffer: xlsx, maxBytes: 4 })).not.toThrow();
    expect(() => validateSpreadsheetUpload({ fileName: "input.xlsx", contentType: "application/octet-stream", buffer: xlsx, maxBytes: 3 })).toThrowError(expect.objectContaining({ status: 413 }));
    expect(() => validateSpreadsheetUpload({ fileName: "input.xlsx", contentType: "text/plain", buffer: xlsx, maxBytes: 4 })).toThrowError(expect.objectContaining({ status: 415 }));
    expect(() => validateSpreadsheetUpload({ fileName: "input.xlsx", contentType: "application/octet-stream", buffer: Uint8Array.from([1, 2, 3, 4]), maxBytes: 4 })).toThrowError(expect.objectContaining({ status: 415 }));
    expect(() => validateSpreadsheetUpload({ fileName: "input.txt", contentType: "text/plain", buffer: xlsx, maxBytes: 4 })).toThrowError(expect.objectContaining({ status: 415 }));
  });

  it("validates decoded image size and MIME signature", () => {
    expect(validateInlineImageDataUrl(pngDataUrl, 9).byteLength).toBe(8);
    expect(validateInlineImageDataUrl(pngDataUrl, 8).byteLength).toBe(8);
    expect(() => validateInlineImageDataUrl(pngDataUrl, 7)).toThrowError(expect.objectContaining({ status: 413 }));
    expect(() => validateInlineImageDataUrl("data:image/png;base64,not-base64", 100)).toThrowError(expect.objectContaining({ status: 415 }));
  });
});

describe("backup, DTO, headers, and redaction", () => {
  it("restores for admins, records safe audit metadata, and preserves dependency failures", async () => {
    const audit = vi.fn(async () => undefined);
    const admin = { ...session, role: "admin" as const };
    await expect(restoreBackupAsAdmin(admin, "backup-key", { restore: async () => "core/tickets.json", audit, now: () => new Date("2026-07-17T00:00:00.000Z") })).resolves.toMatchObject({ target: "core/tickets.json", result: "success" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actor: "operator", details: { target: "core/tickets.json", restoredAt: "2026-07-17T00:00:00.000Z", result: "success" } }));
    await expect(restoreBackupAsAdmin(session, "backup-key", { restore: async () => "never", audit })).rejects.toMatchObject({ status: 403 });
    const storageFailure = new Error("storage denied");
    await expect(restoreBackupAsAdmin(admin, "backup-key", { restore: async () => { throw storageFailure; }, audit })).rejects.toBe(storageFailure);
  });

  it("rejects malformed backup paths", () => {
    expect(backupTarget("backups/core/tickets-1700000000000-aabbccdd.json").target).toBe("core/tickets.json");
    expect(() => backupTarget("backups/../../auth/users-1700000000000-aabbccdd.json")).toThrow("Invalid backup path");
    expect(() => backupTarget("backups/unknown/value-1700000000000-aabbccdd.json")).toThrow("Unknown backup target");
    expect(() => backupTarget("auth/users.json")).toThrow("Invalid backup path");
  });

  it("redacts user DTO and logged secrets", () => {
    expect(toAdminUserDto(user)).toEqual({ id: user.id, username: user.username, name: user.name, email: user.email, role: user.role, active: user.active });
    expect(JSON.stringify(toAdminUserDto(user))).not.toContain("passwordHash");
    const redacted = JSON.stringify(redactSensitive({ password: "plain", authorization: "Bearer token", nested: { dataUrl: "data:image/png;base64,secret" } }));
    expect(redacted).not.toContain("plain");
    expect(redacted).not.toContain("Bearer token");
    expect(redacted).not.toContain("base64,secret");
  });

  it("sets framing and content security headers with production-only HSTS", () => {
    const production = buildSecurityHeaders({ production: true, supabaseUrl: "https://project.example.test" });
    expect(production).toContainEqual({ key: "X-Frame-Options", value: "DENY" });
    expect(production.find((header) => header.key === "Content-Security-Policy")?.value).toContain("frame-ancestors 'none'");
    expect(production.some((header) => header.key === "Strict-Transport-Security")).toBe(true);
    expect(buildSecurityHeaders({ production: false }).some((header) => header.key === "Strict-Transport-Security")).toBe(false);
  });
});
