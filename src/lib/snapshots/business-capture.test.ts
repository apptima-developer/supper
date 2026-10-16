import { it, expect } from "vitest";
import { backupTarget, isKnownBackupTarget, isActiveBackupTarget } from "../backup-restore-policy";
it("permits local business-state manifests without exposing cluster restore through application Settings",()=>{
  expect(backupTarget("backups/recovery/business-state-1792119458950-aabbccdd.json").target).toBe("recovery/business-state.json");
  expect(isKnownBackupTarget("recovery/business-state.json")).toBe(false);
  for(const backend of ["local-json","supabase","supabase-relational"] as const) expect(isActiveBackupTarget(backend,"recovery/business-state.json")).toBe(false);
  expect(()=>backupTarget("backups/recovery/cluster-1792119458950-aabbccdd.json")).toThrow();
});
