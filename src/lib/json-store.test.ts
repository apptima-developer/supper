import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DataBackend } from "./env";

const backupPath = "backups/imports/mappings-1700000000000-aabbccdd.json";

const fsMocks = {
  access: vi.fn(),
  copyFile: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  rename: vi.fn(),
  writeFile: vi.fn(),
};

const storeMocks = {
  getStore: vi.fn(),
  getStores: vi.fn(),
  listStoreKeys: vi.fn(),
  setStore: vi.fn(),
};

async function loadJsonStore(backend: DataBackend) {
  vi.resetModules();
  vi.stubEnv("DATA_BACKEND", backend);
  vi.doMock("node:fs", () => ({ promises: fsMocks }));
  vi.doMock("./store", () => storeMocks);
  return import("./json-store");
}

describe("json-store backend behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.readdir.mockResolvedValue([]);
    fsMocks.readFile.mockResolvedValue('{"source":true}');
    fsMocks.copyFile.mockResolvedValue(undefined);
    fsMocks.writeFile.mockResolvedValue(undefined);
    fsMocks.rename.mockResolvedValue(undefined);
    storeMocks.listStoreKeys.mockResolvedValue([backupPath]);
    storeMocks.getStore.mockImplementation(async (key: string) => (
      key === backupPath ? { source: true } : { current: true }
    ));
    storeMocks.setStore.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("node:fs");
    vi.doUnmock("./store");
  });

  it("uses local data/backups only in local-json mode", async () => {
    const jsonStore = await loadJsonStore("local-json");

    await expect(jsonStore.listBackups()).resolves.toEqual([]);
    await expect(jsonStore.restoreBackup(backupPath)).resolves.toBe("imports/mappings.json");

    expect(fsMocks.readdir).toHaveBeenCalled();
    expect(fsMocks.readFile).toHaveBeenCalled();
    expect(storeMocks.listStoreKeys).not.toHaveBeenCalled();
    expect(storeMocks.getStore).not.toHaveBeenCalled();
  });

  it.each(["supabase", "supabase-relational"] as const)(
    "uses app_store for backup listing and restoration in %s mode",
    async (backend) => {
      const jsonStore = await loadJsonStore(backend);

      await expect(jsonStore.listBackups()).resolves.toEqual([backupPath]);
      await expect(jsonStore.restoreBackup(backupPath)).resolves.toBe("imports/mappings.json");

      expect(storeMocks.listStoreKeys).toHaveBeenCalledWith("backups/");
      expect(storeMocks.getStore).toHaveBeenCalledWith(backupPath);
      expect(storeMocks.setStore).toHaveBeenCalledWith("imports/mappings.json", { source: true });
      expect(fsMocks.readdir).not.toHaveBeenCalled();
      expect(fsMocks.readFile).not.toHaveBeenCalled();
      expect(fsMocks.writeFile).not.toHaveBeenCalled();
    },
  );

  it.each(["supabase", "supabase-relational"] as const)(
    "propagates app_store read and write failures without using local files in %s mode",
    async (backend) => {
      const jsonStore = await loadJsonStore(backend);
      const readFailure = new Error("app_store read permission denied");
      storeMocks.getStore.mockRejectedValueOnce(readFailure);

      await expect(jsonStore.readJson("imports/mappings.json", z.object({}))).rejects.toBe(readFailure);

      const writeFailure = new Error("app_store write permission denied");
      storeMocks.getStore.mockResolvedValueOnce(undefined);
      storeMocks.setStore.mockRejectedValueOnce(writeFailure);
      await expect(jsonStore.writeJsonAtomic("imports/mappings.json", {}, z.object({}))).rejects.toBe(writeFailure);

      expect(fsMocks.readFile).not.toHaveBeenCalled();
      expect(fsMocks.mkdir).not.toHaveBeenCalled();
      expect(fsMocks.writeFile).not.toHaveBeenCalled();
    },
  );

  it.each(["supabase", "supabase-relational"] as const)(
    "propagates backup listing failures without scanning local backups in %s mode",
    async (backend) => {
      const jsonStore = await loadJsonStore(backend);
      const failure = new Error("app_store backup listing denied");
      storeMocks.listStoreKeys.mockRejectedValueOnce(failure);

      await expect(jsonStore.listBackups()).rejects.toBe(failure);
      expect(fsMocks.readdir).not.toHaveBeenCalled();
    },
  );
});
