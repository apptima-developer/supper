import { describe, expect, it } from "vitest";
import { resolveStorageRouting, usesRelationalCoreStorage } from "./storage-routing";

describe("storage routing", () => {
  it("routes local-json core and auxiliary data to local files", () => {
    expect(resolveStorageRouting("local-json")).toEqual({
      coreData: "local-files",
      auxiliaryJson: "local-files",
      strictAuxiliaryJson: false,
    });
  });

  it("routes supabase core and auxiliary data to app_store strictly", () => {
    expect(resolveStorageRouting("supabase")).toEqual({
      coreData: "supabase-app-store",
      auxiliaryJson: "supabase-app-store",
      strictAuxiliaryJson: true,
    });
  });

  it("keeps relational core data separate from strict app_store auxiliary data", () => {
    expect(resolveStorageRouting("supabase-relational")).toEqual({
      coreData: "supabase-relational",
      auxiliaryJson: "supabase-app-store",
      strictAuxiliaryJson: true,
    });
    expect(usesRelationalCoreStorage("supabase-relational")).toBe(true);
    expect(usesRelationalCoreStorage("supabase")).toBe(false);
    expect(usesRelationalCoreStorage("local-json")).toBe(false);
  });
});
