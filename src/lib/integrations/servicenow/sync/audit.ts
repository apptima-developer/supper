import type { Session } from "../../../auth";
import type { Audit } from "../../../types";
import type { SyncRunSummary } from "../../sync/contracts";

export async function writeServiceNowSyncAudit(
  summary: SyncRunSummary,
  session: Session,
  write: (entry: Omit<Audit, "id" | "createdAt">) => Promise<unknown>,
) {
  if (summary.dryRun) return false;
  await write({
    action: "update",
    entity: "integration-sync",
    entityId: summary.runId,
    actor: session.username,
    details: {
      provider: "servicenow",
      mode: summary.mode,
      runId: summary.runId,
      status: summary.status,
      created: summary.created,
      updated: summary.updated,
      failed: summary.failed,
      watermark: summary.watermarkTo || summary.watermarkFrom || null,
      timestamp: summary.completedAt,
    },
  });
  return true;
}

export async function writeServiceNowSyncAuditBestEffort(
  summary: SyncRunSummary,
  session: Session,
  dependencies: {
    write: (entry: Omit<Audit, "id" | "createdAt">) => Promise<unknown>;
    markFailed?: (runId: string) => Promise<void>;
    reportCritical: (event: "SERVICENOW_SYNC_COMPLETED_AUDIT_FAILED" | "SERVICENOW_SYNC_AUDIT_MARKER_FAILED", error: unknown) => void;
  },
) {
  try {
    await writeServiceNowSyncAudit(summary, session, dependencies.write);
    return undefined;
  } catch (error) {
    summary.auditWarning = "secondary_audit_write_failed";
    dependencies.reportCritical("SERVICENOW_SYNC_COMPLETED_AUDIT_FAILED", error);
    if (dependencies.markFailed) {
      try {
        await dependencies.markFailed(summary.runId);
      } catch (markerError) {
        dependencies.reportCritical("SERVICENOW_SYNC_AUDIT_MARKER_FAILED", markerError);
      }
    }
    return summary.auditWarning;
  }
}
