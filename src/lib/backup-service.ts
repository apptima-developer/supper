import type { Session } from "./auth";
import { HttpError } from "./request-security";

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
};

export async function restoreBackupAsAdmin(
  session: Session,
  backup: string,
  dependencies: BackupDependencies,
) {
  if (session.role !== "admin") throw new HttpError(403, "ADMIN_REQUIRED", "Admin role required");
  const target = await dependencies.restore(backup);
  const restoredAt = (dependencies.now?.() || new Date()).toISOString();
  await dependencies.audit({
    action: "restore",
    entity: "backup",
    entityId: target,
    actor: session.username,
    details: { target, restoredAt, result: "success" },
  });
  return { target, restoredAt, result: "success" as const };
}
