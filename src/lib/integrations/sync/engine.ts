import type { SyncCounters, SyncCursor, SyncEngineOptions, SyncOutcome, SyncRunItem, SyncRunSummary } from "./contracts";

const emptyCounters = (): SyncCounters => ({ fetched: 0, created: 0, updated: 0, unchanged: 0, stale: 0, skipped: 0, failed: 0, pages: 0 });

function errorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code)) return error.code;
  if (error instanceof DOMException && error.name === "AbortError") return "SYNC_ABORTED";
  return "SYNC_RECORD_INVALID";
}

function increment(counters: SyncCounters, outcome: SyncOutcome) {
  counters[outcome] += 1;
}

export function compareSyncCursors(left: SyncCursor, right: SyncCursor) {
  const leftTime = new Date(left.updatedAt).getTime();
  const rightTime = new Date(right.updatedAt).getTime();
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime) || !left.sysId || !right.sysId) {
    throw Object.assign(new Error("Synchronization cursor is invalid"), { code: "SYNC_CURSOR_INVALID" });
  }
  const time = leftTime - rightTime;
  return time || left.sysId.localeCompare(right.sysId);
}

function providerFailureCategory(error: unknown) {
  const code = errorCode(error);
  if (code === "SYNC_LOCK_LOST") return "lock_lost";
  return code.toLowerCase();
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
  const watermarkFrom = options.mode === "incremental" ? state?.watermarkAt : undefined;
  const watermarkFromSysId = options.mode === "incremental" ? state?.watermarkSysId : undefined;
  const windowStart = options.mode === "incremental" && state?.watermarkAt
    ? new Date(new Date(state.watermarkAt).getTime() - options.overlapSeconds * 1_000).toISOString()
    : new Date(started.getTime() - options.initialLookbackDays * 86_400_000).toISOString();
  const windowEnd = startedAt;
  const initialCursor = options.mode === "incremental" && state?.watermarkAt && state.watermarkSysId && options.overlapSeconds === 0
    ? { updatedAt: state.watermarkAt, sysId: state.watermarkSysId }
    : undefined;

  await options.repository.createRun({
    id: runId,
    mode: options.mode,
    dryRun: options.dryRun,
    requestedByUserId: options.requestedByUserId,
    requestId: options.requestId,
    correlationId: options.correlationId,
    startedAt,
    watermarkFrom,
    watermarkFromSysId,
    windowStart,
    windowEnd,
  });

  let ownsLock = false;
  let highestCursor: SyncCursor | undefined;
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
      watermarkFromSysId,
      watermarkTo: status === "succeeded" ? highestCursor?.updatedAt : undefined,
      watermarkToSysId: status === "succeeded" ? highestCursor?.sysId : undefined,
      windowStart,
      windowEnd,
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

    let cursor = initialCursor;
    while (counters.pages < options.maxPages && counters.fetched < options.maxRecords) {
      if (options.abortSignal?.aborted) throw Object.assign(new Error("Synchronization was aborted"), { code: "SYNC_ABORTED" });
      await refreshLockIfNeeded();

      const pageLimit = Math.min(options.pageSize, options.maxRecords - counters.fetched);
      const page = await options.provider.fetchPage({ windowStart, windowEnd, cursor, limit: pageLimit, signal: options.abortSignal });
      counters.pages += 1;
      counters.fetched += page.length;

      const pageCursors = page.map((raw) => options.provider.cursor(raw));
      let previous = cursor;
      for (const candidate of pageCursors) {
        if (new Date(candidate.updatedAt).getTime() > started.getTime() || new Date(candidate.updatedAt).getTime() < new Date(windowStart).getTime()) {
          throw Object.assign(new Error("Provider cursor is outside the fixed synchronization window"), { code: "SYNC_CURSOR_OUT_OF_WINDOW" });
        }
        if (previous && compareSyncCursors(candidate, previous) <= 0) {
          throw Object.assign(new Error("Provider cursor order is not strictly increasing"), { code: "SYNC_CURSOR_ORDER_INVALID" });
        }
        previous = candidate;
      }

      for (const [index, raw] of page.entries()) {
        await refreshLockIfNeeded();
        const identified = options.provider.identify(raw);
        let item: SyncRunItem | undefined;
        try {
          const prepared = options.provider.prepare(raw, now().toISOString());
          if (compareSyncCursors(prepared.sourceCursor, pageCursors[index]) !== 0) {
            throw Object.assign(new Error("Prepared record cursor does not match its source cursor"), { code: "SYNC_CURSOR_MISMATCH" });
          }
          const decision = options.dryRun
            ? await options.repository.preview(prepared.mapped)
            : await options.repository.upsert(prepared.mapped);
          increment(counters, decision.outcome);
          item = {
            id: createId(),
            runId,
            externalSysId: prepared.externalSysId,
            externalNumber: prepared.externalNumber,
            ticketId: decision.ticketId,
            outcome: decision.outcome,
            sourceUpdatedAt: prepared.sourceUpdatedAt,
            safeErrorCode: decision.safeErrorCode,
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

      if (pageCursors.length) {
        cursor = pageCursors.at(-1);
        highestCursor = cursor;
      }

      if (page.length < pageLimit) {
        completedInterval = true;
        break;
      }
    }

    status = counters.failed > 0 || !completedInterval ? "partial" : "succeeded";
    if (!completedInterval) safeErrorCategory = "bounded_truncation";
    else if (counters.failed > 0) safeErrorCategory = "record_failures";
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
    safeErrorCategory = providerFailureCategory(error);
    return await finish();
  } finally {
    if (ownsLock) {
      try { await options.repository.releaseLock(lockToken); } catch { /* The TTL remains the final safety boundary. */ }
    }
  }
}
