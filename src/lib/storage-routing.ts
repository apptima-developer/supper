import type { DataBackend } from "./env";

export type CoreDataStorage = "local-files" | "supabase-app-store" | "supabase-relational";
export type AuxiliaryJsonStorage = "local-files" | "supabase-app-store";

export type StorageRouting = {
  coreData: CoreDataStorage;
  auxiliaryJson: AuxiliaryJsonStorage;
  strictAuxiliaryJson: boolean;
};

export function resolveStorageRouting(backend: DataBackend): StorageRouting {
  switch (backend) {
    case "local-json":
      return {
        coreData: "local-files",
        auxiliaryJson: "local-files",
        strictAuxiliaryJson: false,
      };
    case "supabase":
      return {
        coreData: "supabase-app-store",
        auxiliaryJson: "supabase-app-store",
        strictAuxiliaryJson: true,
      };
    case "supabase-relational":
      return {
        coreData: "supabase-relational",
        auxiliaryJson: "supabase-app-store",
        strictAuxiliaryJson: true,
      };
  }
}

export function usesRelationalCoreStorage(backend: DataBackend) {
  return resolveStorageRouting(backend).coreData === "supabase-relational";
}
