import { afterEach, beforeEach, expect, it, vi } from "vitest";
const chain = vi.hoisted(() => ({ select: vi.fn(), eq: vi.fn(), update: vi.fn(), insert: vi.fn(), maybeSingle: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./supabaseAdmin", () => ({ supabaseAdmin: { from: () => chain } }));
import { getVersionedStore, setStoreIfUnchanged } from "./store";
beforeEach(() => { vi.clearAllMocks(); chain.eq.mockReturnValue(chain); chain.update.mockReturnValue(chain); chain.insert.mockReturnValue(chain); chain.select.mockReturnValue(chain); });
afterEach(() => vi.useRealTimers());
it("reads the payload and persisted version together", async () => {
  chain.maybeSingle.mockResolvedValue({ data: { value: { n: 1 }, updated_at: "2026-01-01T00:00:00Z" }, error: null });
  expect(await getVersionedStore("imports/mappings.json")).toEqual({ value: { n: 1 }, updatedAt: "2026-01-01T00:00:00Z" });
  expect(chain.select).toHaveBeenCalledWith("value,updated_at");
});
it("conditions updates on both key and version, advancing the version even within one millisecond", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  chain.select.mockResolvedValue({ data: [{ key: "imports/mappings.json" }], error: null });
  await setStoreIfUnchanged("imports/mappings.json", { n: 2 }, "2026-01-01T00:00:00Z");
  expect(chain.eq).toHaveBeenCalledWith("key", "imports/mappings.json");
  expect(chain.eq).toHaveBeenCalledWith("updated_at", "2026-01-01T00:00:00Z");
  expect(chain.update).toHaveBeenCalledWith({ value: { n: 2 }, updated_at: "2026-01-01T00:00:00.001Z" });
});
it("rejects concurrent updates and failed inserts rather than overwriting", async () => {
  chain.select.mockResolvedValue({ data: [], error: null });
  await expect(setStoreIfUnchanged("imports/mappings.json", {}, "2026-01-01T00:00:00Z")).rejects.toThrow("concurrently");
  chain.select.mockResolvedValue({ data: null, error: { message: "conflict" } });
  await expect(setStoreIfUnchanged("imports/mappings.json", {}, undefined)).rejects.toThrow();
  expect(chain.insert).toHaveBeenCalled();
});
