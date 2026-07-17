import type { Session } from "./auth";
import { HttpError } from "./request-security";
import { logServerCritical } from "./server-logging";

type BackupDependencies = {
  restore: (backup: string) => Promise<string>;
  audit: (entry: {
    action: "restore";
    entity: string;
    entityId: string;
    actor: string;
    details: Record<string, unknown>;
  }) => Promise<unknown>;
  now?: () => Date;
  operationId?: string;
  logCritical?: typeof logServerCritical;
};

export async function restoreBackupAsAdmin(
  session: Session,
  backup: string,
  dependencies: BackupDependencies,
) {
  if (session.role !== "admin") throw new HttpError(403, "ADMIN_REQUIRED", "Admin role required");
  const target = await dependencies.restore(backup);
  const restoredAt = (dependencies.now?.() || new Date()).toISOString();
  const operationId = dependencies.operationId || crypto.randomUUID();
  try {
    await dependencies.audit({
      action: "restore",
      entity: "backup",
      entityId: target,
      actor: session.username,
      details: { target, restoredAt, result: "success", operationId },
    });
    return { target, restoredAt, result: "success" as const, audit: "recorded" as const, operationId };
  } catch (error) {
    (dependencies.logCritical || logServerCritical)("RESTORE_SUCCEEDED_AUDIT_FAILED", error, {
      operationId,
      target,
      actor: session.username,
    });
    return {
      target,
      restoredAt,
      result: "success" as const,
      audit: "failed" as const,
      operationId,
      warning: "Restore completed, but its audit record could not be written",
    };
  }
}
