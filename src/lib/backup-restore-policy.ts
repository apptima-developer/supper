import type { DataBackend } from "./env";
import { HttpError } from "./request-security";

const jsonBackupTargets = [
  "audit/audit-log.json",
  "auth/users.json",
  "core/customers.json",
  "core/ticket-history.json",
  "core/tickets.json",
  "imports/import-batches.json",
  "imports/mappings.json",
  "master/categories.json",
  "master/contract-types.json",
  "master/holidays.json",
  "master/issue-types.json",
  "master/priorities.json",
  "master/sla.json",
  "master/statuses.json",
  "master/teams.json",
  "reports/report-jobs.json",
] as const;

const allJsonTargets = new Set<string>(jsonBackupTargets);
const relationalAuxiliaryTargets = new Set<string>(["imports/mappings.json"]);

export class InactiveBackupTargetError extends HttpError {
  constructor(readonly backend: DataBackend, readonly target: string) {
    super(409, "INACTIVE_BACKUP_TARGET", `Backup target is not active for ${backend} storage`);
    this.name = "InactiveBackupTargetError";
  }
}

export function isKnownBackupTarget(target: string) {
  return allJsonTargets.has(target);
}

export function activeRestorableTargets(backend: DataBackend) {
  return backend === "supabase-relational"
    ? [...relationalAuxiliaryTargets]
    : [...allJsonTargets];
}

export function isActiveBackupTarget(backend: DataBackend, target: string) {
  return backend === "supabase-relational"
    ? relationalAuxiliaryTargets.has(target)
    : allJsonTargets.has(target);
}

export function assertActiveBackupTarget(backend: DataBackend, target: string) {
  if (!isActiveBackupTarget(backend, target)) throw new InactiveBackupTargetError(backend, target);
}

export function settingsStorageDescription(backend: DataBackend) {
  switch (backend) {
    case "local-json":
      return {
        root: "Local data/ directory",
        writes: "Validated temporary file and atomic rename",
        retention: "JSON snapshot before each active target write",
        restore: "Active local JSON targets",
      };
    case "supabase":
      return {
        root: "Supabase app_store JSONB",
        writes: "Server-side app_store upsert",
        retention: "app_store snapshot before each active target write",
        restore: "Active app_store JSON targets",
      };
    case "supabase-relational":
      return {
        root: "Relational support_* tables plus auxiliary app_store JSONB",
        writes: "Relational repositories; app_store for active auxiliary JSON only",
        retention: "Import snapshots for relational rollback; app_store snapshots for mappings",
        restore: "Settings restores only active imports/mappings.json backups",
      };
  }
}
