import { describe, expect, it, vi } from "vitest";
import { JsonStoreRecordNotFoundError } from "./json-store";
import { defaultImportMappings, loadImportMappings } from "./import-mappings";

describe("runtime import mappings", () => {
  it("uses source defaults when no local override file exists", async () => {
    const missingFile = Object.assign(new Error("missing mapping file"), { code: "ENOENT" });
    const reader = vi.fn().mockRejectedValue(missingFile);

    await expect(loadImportMappings(undefined, reader)).resolves.toEqual(defaultImportMappings);
  });

  it("uses source defaults when app_store has no optional mapping record", async () => {
    const reader = vi.fn().mockRejectedValue(new JsonStoreRecordNotFoundError("imports/mappings.json"));

    await expect(loadImportMappings(undefined, reader)).resolves.toEqual(defaultImportMappings);
  });

  it("merges a runtime mapping override with source defaults", async () => {
    const reader = vi.fn().mockResolvedValue({
      snow: { issueId: "Ticket Number" },
      supportdesk: { customerAliases: { EXAMPLE: "Example Co" } },
    });

    const mappings = await loadImportMappings(undefined, reader);

    expect(reader).toHaveBeenCalledWith("imports/mappings.json", expect.anything());
    expect(mappings.snow.issueId).toBe("Ticket Number");
    expect(mappings.snow.issueTitle).toBe(defaultImportMappings.snow.issueTitle);
    expect(mappings.supportdesk.customerAliases).toEqual({ EXAMPLE: "Example Co" });
  });

  it("does not mistake Supabase connection or permission failures for a missing override", async () => {
    const failure = new Error("Failed to read app_store.imports/mappings.json: permission denied");
    const reader = vi.fn().mockRejectedValue(failure);

    await expect(loadImportMappings(undefined, reader)).rejects.toBe(failure);
  });
});
