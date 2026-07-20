import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../../auth";
import type { SyncRunSummary } from "../../sync/contracts";
import { handleServiceNowSyncGet, handleServiceNowSyncPost, type ServiceNowSyncApiDependencies } from "./api-handlers";
import { ServiceNowSyncUnavailableError } from "./errors";

const admin: Session = { userId: "admin-id", username: "admin", name: "Admin", role: "admin", authVersion: 1 };
const support: Session = { ...admin, userId: "support-id", username: "support", role: "support" };
const summary: SyncRunSummary = {
  runId: "run-1", mode: "initial", dryRun: true, status: "succeeded", fetched: 1,
  created: 1, updated: 0, unchanged: 0, stale: 0, skipped: 0, failed: 0, pages: 1,
  watermarkFrom: "2026-07-01T00:00:00.000Z", watermarkTo: "2026-07-20T00:00:00.000Z",
  watermarkToSysId: "a".repeat(32), windowStart: "2026-07-01T00:00:00.000Z", windowEnd: "2026-07-20T00:00:01.000Z",
  startedAt: "2026-07-20T00:00:00.000Z", completedAt: "2026-07-20T00:00:01.000Z", duration: 1000,
};

function dependencies(session: Session | null): ServiceNowSyncApiDependencies & { startSync: ReturnType<typeof vi.fn> } {
  return {
    getSession: vi.fn(async () => session),
    startSync: vi.fn(async () => summary),
    getStatus: vi.fn(async () => ({ enabled: true, running: false, state: { watermarkAt: summary.watermarkTo, lastAttemptAt: summary.completedAt, lastSuccessfulSyncAt: summary.completedAt }, runs: [] })),
  };
}

function post(body: unknown, contentType = "application/json") {
  return new Request("https://app.example.com/api/integrations/servicenow/sync", { method: "POST", headers: { "Content-Type": contentType }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

describe("ServiceNow synchronization API", () => {
  it("returns 401 without a session and 403 without Settings permission", async () => {
    expect((await handleServiceNowSyncPost(post({ mode: "initial", dryRun: true }), dependencies(null))).status).toBe(401);
    expect((await handleServiceNowSyncGet(new Request("https://app.example.com/api/integrations/servicenow/sync"), dependencies(support))).status).toBe(403);
  });

  it("strictly validates a bounded body without arbitrary query, table, field, watermark, URL, or credentials", async () => {
    const invalid = await handleServiceNowSyncPost(post({ mode: "initial", dryRun: true, query: "active=true" }), dependencies(admin));
    expect(invalid.status).toBe(400);
    const malformed = await handleServiceNowSyncPost(post("{"), dependencies(admin));
    expect(malformed.status).toBe(400);
    const unsupported = await handleServiceNowSyncPost(post("mode=initial", "application/x-www-form-urlencoded"), dependencies(admin));
    expect(unsupported.status).toBe(415);
  });

  it("passes only validated controls and returns a sanitized summary without raw Incidents", async () => {
    const deps = dependencies(admin);
    const response = await handleServiceNowSyncPost(post({ mode: "initial", dryRun: true }), deps);
    expect(response.status).toBe(200);
    expect(deps.startSync).toHaveBeenCalledWith(expect.objectContaining({ mode: "initial", dryRun: true, session: admin }));
    const body = await response.json();
    expect(body).toMatchObject({ runId: "run-1", status: "succeeded", fetched: 1, created: 1 });
    expect(body).toMatchObject({ watermarkToSysId: "a".repeat(32), windowStart: summary.windowStart, windowEnd: summary.windowEnd });
    expect(JSON.stringify(body)).not.toMatch(/short_description|description|authorization|password|token|sysparm_query/i);
  });

  it("returns a safe disabled response", async () => {
    const deps = dependencies(admin);
    deps.startSync.mockRejectedValue(new ServiceNowSyncUnavailableError("SERVICENOW_SYNC_DISABLED", "ServiceNow synchronization is disabled"));
    const response = await handleServiceNowSyncPost(post({ mode: "initial", dryRun: true }), deps);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SERVICENOW_SYNC_DISABLED", category: "configuration" });
  });

  it("returns a sanitized failed run summary", async () => {
    const deps = dependencies(admin);
    deps.startSync.mockResolvedValue({ ...summary, status: "failed", safeErrorCategory: "timeout", failed: 1 });
    const body = await (await handleServiceNowSyncPost(post({ mode: "incremental", dryRun: false }), deps)).json();
    expect(body).toMatchObject({ status: "failed", safeErrorCategory: "timeout", failed: 1 });
    expect(body).not.toHaveProperty("stack");
  });

  it("bounds GET status to ten safe run summaries", async () => {
    const deps = dependencies(admin);
    deps.getStatus = vi.fn(async () => ({ enabled: true, running: true, state: { watermarkAt: summary.watermarkTo }, runs: Array.from({ length: 20 }, (_, index) => ({ id: `run-${index}`, mode: "initial", status: "succeeded", dry_run: false, records_fetched: index })) }));
    const body = await (await handleServiceNowSyncGet(new Request("https://app.example.com/api/integrations/servicenow/sync"), deps)).json();
    expect(body.running).toBe(true);
    expect(body.runs).toHaveLength(10);
    expect(body.runs[0]).toMatchObject({ runId: "run-0", fetched: 0 });
  });

  it("exposes only the sanitized secondary-audit marker from run metadata", async () => {
    const deps = dependencies(admin);
    deps.getStatus = vi.fn(async () => ({
      enabled: true,
      running: false,
      state: { watermarkAt: summary.watermarkTo, watermarkSysId: summary.watermarkToSysId },
      runs: [{
        id: "run-audit-warning", mode: "incremental", status: "succeeded", dry_run: false,
        metadata: { auditWriteFailed: true, privateDatabaseError: "must not escape" },
      }],
    }));
    const body = await (await handleServiceNowSyncGet(new Request("https://app.example.com/api/integrations/servicenow/sync"), deps)).json();
    expect(body).toMatchObject({ currentWatermarkSysId: "a".repeat(32) });
    expect(body.runs[0]).toMatchObject({ status: "succeeded", auditWarning: "secondary_audit_write_failed" });
    expect(JSON.stringify(body)).not.toContain("privateDatabaseError");
    expect(JSON.stringify(body)).not.toContain("must not escape");
  });
});
