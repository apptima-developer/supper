import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../../auth";
import type { SyncRunSummary } from "../../sync/contracts";
import { writeServiceNowSyncAudit, writeServiceNowSyncAuditBestEffort } from "./audit";
import { parseServiceNowSyncConfig } from "./config";

const session: Session = { userId: "admin-id", username: "admin", name: "Admin", role: "admin", authVersion: 1 };
const summary: SyncRunSummary = {
  runId: "run-1", mode: "incremental", dryRun: false, status: "succeeded",
  fetched: 2, created: 1, updated: 1, unchanged: 0, stale: 0, skipped: 0, failed: 0, pages: 1,
  watermarkFrom: "2026-07-19T00:00:00.000Z", watermarkTo: "2026-07-20T00:00:00.000Z",
  watermarkToSysId: "a".repeat(32), windowStart: "2026-07-19T00:00:00.000Z", windowEnd: "2026-07-20T00:00:01.000Z",
  startedAt: "2026-07-20T00:00:00.000Z", completedAt: "2026-07-20T00:00:01.000Z", duration: 1000,
};

describe("ServiceNow synchronization configuration and audit", () => {
  it("defaults synchronization off while retaining bounded defaults", () => {
    expect(parseServiceNowSyncConfig({})).toEqual({ enabled: false, initialLookbackDays: 30, overlapSeconds: 120, maxRecords: 1000, maxPages: 20, lockTtlSeconds: 300 });
  });

  it("normalizes the sync flag and numeric whitespace without accepting aliases", () => {
    expect(parseServiceNowSyncConfig({ SERVICENOW_SYNC_ENABLED: " TRUE ", SERVICENOW_SYNC_MAX_RECORDS: " 50 " })).toMatchObject({ enabled: true, maxRecords: 50 });
    expect(parseServiceNowSyncConfig({ SERVICENOW_SYNC_ENABLED: " False " })).toMatchObject({ enabled: false });
    expect(() => parseServiceNowSyncConfig({ SERVICENOW_SYNC_ENABLED: "enabled" })).toThrow();
  });

  it("rejects unsafe synchronization bounds", () => {
    expect(() => parseServiceNowSyncConfig({ SERVICENOW_SYNC_MAX_RECORDS: "5001" })).toThrow();
    expect(() => parseServiceNowSyncConfig({ SERVICENOW_SYNC_LOCK_TTL_SECONDS: "29" })).toThrow();
  });

  it("writes one bounded audit entry for a committed manual synchronization", async () => {
    const write = vi.fn(async () => undefined);
    await expect(writeServiceNowSyncAudit(summary, session, write)).resolves.toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({
      action: "update", entity: "integration-sync", entityId: "run-1", actor: "admin",
      details: { provider: "servicenow", mode: "incremental", runId: "run-1", status: "succeeded", created: 1, updated: 1, failed: 0, watermark: "2026-07-20T00:00:00.000Z", timestamp: "2026-07-20T00:00:01.000Z" },
    });
  });

  it("does not write the general audit log for dry-run", async () => {
    const write = vi.fn(async () => undefined);
    await expect(writeServiceNowSyncAudit({ ...summary, dryRun: true }, session, write)).resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps a committed success while surfacing and persisting a bounded secondary-audit warning", async () => {
    const committed = { ...summary };
    const markFailed = vi.fn(async () => undefined);
    const reportCritical = vi.fn();
    await expect(writeServiceNowSyncAuditBestEffort(committed, session, {
      write: vi.fn(async () => { throw new Error("private database detail"); }),
      markFailed,
      reportCritical,
    })).resolves.toBe("secondary_audit_write_failed");
    expect(committed).toMatchObject({ status: "succeeded", auditWarning: "secondary_audit_write_failed" });
    expect(markFailed).toHaveBeenCalledWith("run-1");
    expect(reportCritical).toHaveBeenCalledWith("SERVICENOW_SYNC_COMPLETED_AUDIT_FAILED", expect.any(Error));
    expect(JSON.stringify(committed)).not.toContain("private database detail");
  });

  it("reports a failed warning marker without changing the committed sync result", async () => {
    const committed = { ...summary };
    const reportCritical = vi.fn();
    await writeServiceNowSyncAuditBestEffort(committed, session, {
      write: vi.fn(async () => { throw new Error("audit unavailable"); }),
      markFailed: vi.fn(async () => { throw new Error("marker unavailable"); }),
      reportCritical,
    });
    expect(committed.status).toBe("succeeded");
    expect(reportCritical).toHaveBeenCalledWith("SERVICENOW_SYNC_AUDIT_MARKER_FAILED", expect.any(Error));
  });
});
