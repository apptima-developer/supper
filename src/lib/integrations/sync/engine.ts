import type { SyncCounters, SyncEngineOptions, SyncOutcome, SyncRunItem, SyncRunSummary } from "./contracts";

const emptyCounters = (): SyncCounters => ({ fetched: 0, created: 0, updated: 0, unchanged: 0, stale: 0, skipped: 0, failed: 0, pages: 0 });

function errorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code)) return error.code;
  if (error instanceof DOMException && error.name === "AbortError") return "SYNC_ABORTED";
  return "SYNC_RECORD_INVALID";
}

function increment(counters: SyncCounters, outcome: SyncOutcome) {
  counters[outcome] += 1;
}

export async function runSyncEngine<Raw, Mapped>(options: SyncEngineOptions<Raw, Mapped>): Promise<SyncRunSummary> {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? (() => crypto.randomUUID());
  const started = now();
  const startedAt = started.toISOString();
  const runId = createId();
  const lockToken = `${createId()}-${createId()}`;
  const counters = emptyCounters();
  const state = await options.repository.getState();
  const watermarkFrom = options.mode === "incremental" && state?.watermarkAt
    ? new Date(new Date(state.watermarkAt).getTime() - options.overlapSeconds * 1_000).toISOString()
    : new Date(started.getTime() - options.initialLookbackDays * 86_400_000).toISOString();

  await options.repository.createRun({
    id: runId,
    mode: options.mode,
    dryRun: options.dryRun,
    requestedByUserId: options.requestedByUserId,
    requestId: options.requestId,
    correlationId: options.correlationId,
    startedAt,
    watermarkFrom,
  });

  let ownsLock = false;
  let highestUpdatedAt: string | undefined;
  let completedInterval = false;
  let safeErrorCategory: string | undefined;
  let status: SyncRunSummary["status"] = "running";
  let lockExpiresAt = 0;

  const refreshLockIfNeeded = async () => {
    const safetyWindow = options.lockRefreshSafetyMs ?? Math.min(30_000, options.lockTtlSeconds * 200);
    if (!ownsLock || now().getTime() < lockExpiresAt - safetyWindow) return;
    const refreshedAt = now();
    const refreshed = await options.repository.acquireLock(lockToken, options.lockTtlSeconds, refreshedAt.toISOString());
    if (!refreshed) throw Object.assign(new Error("Synchronization lock was lost"), { code: "SYNC_LOCK_LOST" });
    lockExpiresAt = refreshedAt.getTime() + options.lockTtlSeconds * 1_000;
  };

  const summary = () => {
    const completed = now();
    return {
      runId,
      mode: options.mode,
      dryRun: options.dryRun,
      status,
      ...counters,
      watermarkFrom,
      watermarkTo: status === "succeeded" ? highestUpdatedAt : undefined,
      startedAt,
      completedAt: completed.toISOString(),
      duration: Math.max(0, completed.getTime() - started.getTime()),
      ...(safeErrorCategory ? { safeErrorCategory } : {}),
    } satisfies SyncRunSummary;
  };

  const finish = async () => {
    const result = summary();
    await options.repository.finishRun(result);
    return result;
  };

  try {
    if (options.dryRun) {
      const locked = state?.lockToken && state.lockedUntil && new Date(state.lockedUntil).getTime() > started.getTime();
      if (locked) {
        status = "blocked";
        safeErrorCategory = "lock_conflict";
        return await finish();
      }
    } else {
      ownsLock = await options.repository.acquireLock(lockToken, options.lockTtlSeconds, startedAt);
      if (!ownsLock) {
        status = "blocked";
        safeErrorCategory = "lock_conflict";
        return await finish();
      }
      lockExpiresAt = started.getTime() + options.lockTtlSeconds * 1_000;
    }

    let offset = 0;
    while (counters.pages < options.maxPages && counters.fetched < options.maxRecords) {
      if (options.abortSignal?.aborted) throw Object.assign(new Error("Synchronization was aborted"), { code: "SYNC_ABORTED" });
      await refreshLockIfNeeded();

      const pageLimit = Math.min(options.pageSize, options.maxRecords - counters.fetched);
      const page = await options.provider.fetchPage({ updatedAfter: watermarkFrom, limit: pageLimit, offset, signal: options.abortSignal });
      counters.pages += 1;
      counters.fetched += page.length;
      offset += page.length;

      for (const raw of page) {
        await refreshLockIfNeeded();
        const identified = options.provider.identify(raw);
        let item: SyncRunItem | undefined;
        try {
          const prepared = options.provider.prepare(raw, now().toISOString());
          const decision = options.dryRun
            ? await options.repository.preview(prepared.mapped)
            : await options.repository.upsert(prepared.mapped);
          increment(counters, decision.outcome);
          if (!highestUpdatedAt || prepared.sourceUpdatedAt > highestUpdatedAt) highestUpdatedAt = prepared.sourceUpdatedAt;
          item = {
            id: createId(),
            runId,
            externalSysId: prepared.externalSysId,
            externalNumber: prepared.externalNumber,
            ticketId: decision.ticketId,
            outcome: decision.outcome,
            sourceUpdatedAt: prepared.sourceUpdatedAt,
            createdAt: now().toISOString(),
            metadata: decision.warningCode ? { warningCode: decision.warningCode } : {},
          };
        } catch (error) {
          counters.failed += 1;
          item = {
            id: createId(),
            runId,
            externalSysId: identified.externalSysId,
            externalNumber: identified.externalNumber,
            outcome: "failed",
            safeErrorCode: errorCode(error),
            createdAt: now().toISOString(),
            metadata: {},
          };
        }
        if (!options.dryRun && item) await options.repository.addRunItem(item);
      }

      if (page.length < pageLimit) {
        completedInterval = true;
        break;
      }
    }

    status = counters.failed > 0 || !completedInterval ? "partial" : "succeeded";
    if (!completedInterval) safeErrorCategory = "bounded_truncation";
    if (status === "succeeded" && !options.dryRun) {
      await refreshLockIfNeeded();
      const result = summary();
      const completed = await options.repository.completeSuccessfulRun(result, lockToken);
      if (!completed) {
        status = "failed";
        safeErrorCategory = "lock_lost";
        return await finish();
      }
      return result;
    }
    return await finish();
  } catch (error) {
    status = "failed";
    safeErrorCategory = errorCode(error).toLowerCase();
    return await finish();
  } finally {
    if (ownsLock) {
      try { await options.repository.releaseLock(lockToken); } catch { /* The TTL remains the final safety boundary. */ }
    }
  }
}
