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
