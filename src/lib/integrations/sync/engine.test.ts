import { describe, expect, it, vi } from "vitest";
import { runSyncEngine } from "./engine";
import type { PreparedSyncRecord, SyncDecision, SyncRepository, SyncRunItem, SyncRunSummary, SyncState } from "./contracts";
import { canAcquireSyncLock, canReleaseSyncLock } from "./lock-policy";

type Raw = { id: string; updatedAt: string; outcome?: SyncDecision["outcome"]; invalid?: boolean };
type Mapped = Raw;

class FakeRepository implements SyncRepository<Mapped> {
  state?: SyncState;
  runs: unknown[] = [];
  finished: SyncRunSummary[] = [];
  items: SyncRunItem[] = [];
  upserts: Mapped[] = [];
  previews: Mapped[] = [];
  completions: SyncRunSummary[] = [];
  releases: string[] = [];
  acquireResult = true;
  acquisitions = 0;
  constructor(state?: SyncState) { this.state = state; }
  async getState() { return this.state; }
  async createRun(input: unknown) { this.runs.push(input); }
  async finishRun(summary: SyncRunSummary) { this.finished.push(summary); }
  async completeSuccessfulRun(summary: SyncRunSummary) { this.completions.push(summary); return true; }
  async acquireLock() { this.acquisitions += 1; return this.acquireResult; }
  async releaseLock(token: string) { this.releases.push(token); return true; }
  async preview(mapped: Mapped) { this.previews.push(mapped); return { outcome: mapped.outcome || "created" } as SyncDecision; }
  async upsert(mapped: Mapped) { this.upserts.push(mapped); return { outcome: mapped.outcome || "created", ticketId: `ticket-${mapped.id}` } as SyncDecision; }
  async addRunItem(item: SyncRunItem) { this.items.push(item); }
}

function createProvider(records: Raw[], fetchOverride?: () => Promise<Raw[]>) {
  const queries: Array<{ updatedAfter: string; limit: number; offset: number }> = [];
  return {
    queries,
    provider: {
      async fetchPage(input: { updatedAfter: string; limit: number; offset: number }) {
        queries.push(input);
        if (fetchOverride) return fetchOverride();
        return records.slice(input.offset, input.offset + input.limit);
      },
      prepare(raw: Raw): PreparedSyncRecord<Mapped> {
        if (raw.invalid) throw Object.assign(new Error("invalid source record"), { code: "INVALID_INCIDENT" });
        return { externalSysId: raw.id, externalNumber: `INC-${raw.id}`, sourceUpdatedAt: raw.updatedAt, mapped: raw };
      },
      identify: (raw: Raw) => ({ externalSysId: raw.id, externalNumber: `INC-${raw.id}` }),
    },
  };
}

function options(repository: FakeRepository, provider: ReturnType<typeof createProvider>["provider"], overrides: Record<string, unknown> = {}) {
  let id = 0;
  return {
    mode: "initial" as const, dryRun: false, requestedByUserId: "admin-id", requestId: "request-1", correlationId: "request-1",
    initialLookbackDays: 30, overlapSeconds: 120, maxRecords: 100, maxPages: 20, pageSize: 2, lockTtlSeconds: 300,
    repository, provider, now: () => new Date("2026-07-20T12:00:00.000Z"), createId: () => `deterministic-id-${++id}`,
    ...overrides,
  };
}

describe("database synchronization lock policy", () => {
  it("allows an empty lock, expired takeover, and same-token refresh", () => {
    expect(canAcquireSyncLock(undefined, "token-b", "2026-07-20T00:00:00Z")).toBe(true);
    expect(canAcquireSyncLock({ lockToken: "token-a", lockedUntil: "2026-07-19T23:59:59Z" }, "token-b", "2026-07-20T00:00:00Z")).toBe(true);
    expect(canAcquireSyncLock({ lockToken: "token-a", lockedUntil: "2026-07-21T00:00:00Z" }, "token-a", "2026-07-20T00:00:00Z")).toBe(true);
  });

  it("rejects another live token and wrong-token release", () => {
    const state = { lockToken: "token-a", lockedUntil: "2026-07-21T00:00:00Z" };
    expect(canAcquireSyncLock(state, "token-b", "2026-07-20T00:00:00Z")).toBe(false);
    expect(canReleaseSyncLock(state, "token-b")).toBe(false);
    expect(canReleaseSyncLock(state, "token-a")).toBe(true);
  });
});

describe("bounded incremental synchronization engine", () => {
  it("uses an initial bounded lookback and advances to the greatest processed timestamp", async () => {
    const repository = new FakeRepository();
    const source = createProvider([{ id: "a", updatedAt: "2026-07-20T10:00:00.000Z" }]);
    const summary = await runSyncEngine(options(repository, source.provider));
    expect(source.queries[0].updatedAfter).toBe("2026-06-20T12:00:00.000Z");
    expect(summary).toMatchObject({ status: "succeeded", fetched: 1, created: 1, pages: 1, watermarkTo: "2026-07-20T10:00:00.000Z" });
    expect(repository.completions).toEqual([expect.objectContaining({ watermarkTo: "2026-07-20T10:00:00.000Z", status: "succeeded" })]);
  });

  it("subtracts the configured overlap from an incremental watermark", async () => {
    const repository = new FakeRepository({ watermarkAt: "2026-07-20T10:00:00.000Z" });
    const source = createProvider([]);
    await runSyncEngine(options(repository, source.provider, { mode: "incremental", overlapSeconds: 120 }));
    expect(source.queries[0].updatedAfter).toBe("2026-07-20T09:58:00.000Z");
  });

  it("paginates with deterministic offsets and correct outcome counters", async () => {
    const repository = new FakeRepository();
    const source = createProvider([
      { id: "a", updatedAt: "2026-07-20T01:00:00Z", outcome: "created" },
      { id: "b", updatedAt: "2026-07-20T02:00:00Z", outcome: "updated" },
      { id: "c", updatedAt: "2026-07-20T03:00:00Z", outcome: "unchanged" },
    ]);
    const summary = await runSyncEngine(options(repository, source.provider));
    expect(source.queries.map((query) => query.offset)).toEqual([0, 2]);
    expect(summary).toMatchObject({ status: "succeeded", fetched: 3, created: 1, updated: 1, unchanged: 1, pages: 2 });
    expect(repository.items.map((item) => item.outcome)).toEqual(["created", "updated", "unchanged"]);
  });

  it.each([
    ["record", { maxRecords: 2, maxPages: 20 }],
    ["page", { maxRecords: 100, maxPages: 1 }],
  ])("marks a deliberate max-%s guard as partial without watermark advancement", async (_label, bounds) => {
    const repository = new FakeRepository();
    const source = createProvider([
      { id: "a", updatedAt: "2026-07-20T01:00:00Z" }, { id: "b", updatedAt: "2026-07-20T02:00:00Z" }, { id: "c", updatedAt: "2026-07-20T03:00:00Z" },
    ]);
    const summary = await runSyncEngine(options(repository, source.provider, bounds));
    expect(summary).toMatchObject({ status: "partial", safeErrorCategory: "bounded_truncation" });
    expect(repository.completions).toHaveLength(0);
  });

  it("runs dry-run decisions without ticket, link, watermark, state, or run-item mutation", async () => {
    const repository = new FakeRepository();
    const source = createProvider([{ id: "a", updatedAt: "2026-07-20T01:00:00Z" }]);
    const summary = await runSyncEngine(options(repository, source.provider, { dryRun: true }));
    expect(summary).toMatchObject({ dryRun: true, status: "succeeded", created: 1 });
    expect(repository.previews).toHaveLength(1);
    expect(repository.upserts).toHaveLength(0);
    expect(repository.items).toHaveLength(0);
    expect(repository.completions).toHaveLength(0);
  });

  it("isolates malformed individual records, marks partial, and does not advance watermark", async () => {
    const repository = new FakeRepository();
    const source = createProvider([{ id: "bad", updatedAt: "bad", invalid: true }, { id: "good", updatedAt: "2026-07-20T02:00:00Z" }]);
    const summary = await runSyncEngine(options(repository, source.provider, { pageSize: 3 }));
    expect(summary).toMatchObject({ status: "partial", failed: 1, created: 1 });
    expect(repository.items.map((item) => item.outcome)).toEqual(["failed", "created"]);
    expect(repository.completions).toHaveLength(0);
  });

  it.each(["SERVICENOW_TIMEOUT", "SERVICENOW_NETWORK_UNAVAILABLE"])("stops a provider-wide %s failure and releases the lock", async (code) => {
    const repository = new FakeRepository();
    const source = createProvider([], async () => { throw Object.assign(new Error("private provider detail"), { code }); });
    const summary = await runSyncEngine(options(repository, source.provider));
    expect(summary).toMatchObject({ status: "failed", safeErrorCategory: code.toLowerCase(), fetched: 0 });
    expect(repository.releases).toHaveLength(1);
    expect(repository.completions).toHaveLength(0);
  });

  it("returns blocked for a lock conflict without fetching or releasing another lock", async () => {
    const repository = new FakeRepository();
    repository.acquireResult = false;
    const source = createProvider([]);
    const summary = await runSyncEngine(options(repository, source.provider));
    expect(summary).toMatchObject({ status: "blocked", safeErrorCategory: "lock_conflict" });
    expect(source.queries).toHaveLength(0);
    expect(repository.releases).toHaveLength(0);
  });

  it("releases the lock after success and handles an AbortSignal without watermark movement", async () => {
    const successfulRepository = new FakeRepository();
    await runSyncEngine(options(successfulRepository, createProvider([]).provider));
    expect(successfulRepository.releases).toHaveLength(1);

    const controller = new AbortController();
    controller.abort();
    const abortedRepository = new FakeRepository();
    const summary = await runSyncEngine(options(abortedRepository, createProvider([]).provider, { abortSignal: controller.signal }));
    expect(summary).toMatchObject({ status: "failed", safeErrorCategory: "sync_aborted" });
    expect(abortedRepository.releases).toHaveLength(1);
    expect(abortedRepository.completions).toHaveLength(0);
  });

  it("refreshes its own lease before work enters the lock-expiration safety window", async () => {
    const repository = new FakeRepository();
    let tick = 0;
    const summary = await runSyncEngine(options(repository, createProvider([{ id: "a", updatedAt: "2026-07-20T01:00:00Z" }]).provider, {
      lockTtlSeconds: 30,
      lockRefreshSafetyMs: 20_000,
      now: () => new Date(Date.UTC(2026, 6, 20, 0, 0, tick++ * 12)),
    }));
    expect(summary.status).toBe("succeeded");
    expect(repository.acquisitions).toBeGreaterThan(1);
  });

  it("does not advance the watermark when the repository reports a lost lock", async () => {
    const repository = new FakeRepository();
    repository.completeSuccessfulRun = vi.fn(async () => false);
    const summary = await runSyncEngine(options(repository, createProvider([{ id: "a", updatedAt: "2026-07-20T01:00:00Z" }]).provider));
    expect(summary).toMatchObject({ status: "failed", safeErrorCategory: "lock_lost" });
  });
});
