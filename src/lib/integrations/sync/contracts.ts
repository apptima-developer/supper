import { z } from "zod";

export const syncModeSchema = z.enum(["initial", "incremental"]);
export const syncStatusSchema = z.enum(["running", "succeeded", "partial", "failed", "blocked"]);
export const syncOutcomeSchema = z.enum(["created", "updated", "unchanged", "stale", "skipped", "failed"]);
export const syncRequestSchema = z.object({ mode: syncModeSchema, dryRun: z.boolean() }).strict();

export type SyncMode = z.infer<typeof syncModeSchema>;
export type SyncStatus = z.infer<typeof syncStatusSchema>;
export type SyncOutcome = z.infer<typeof syncOutcomeSchema>;

export type SyncCounters = {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  stale: number;
  skipped: number;
  failed: number;
  pages: number;
};

export type SyncRunSummary = SyncCounters & {
  runId: string;
  mode: SyncMode;
  dryRun: boolean;
  status: SyncStatus;
  watermarkFrom?: string;
  watermarkTo?: string;
  startedAt: string;
  completedAt: string;
  duration: number;
  safeErrorCategory?: string;
};

export type SyncState = {
  watermarkAt?: string;
  lastAttemptAt?: string;
  lastSuccessfulSyncAt?: string;
  lockToken?: string;
  lockedUntil?: string;
};

export type SyncRunItem = {
  id: string;
  runId: string;
  externalSysId?: string;
  externalNumber?: string;
  ticketId?: string;
  outcome: SyncOutcome;
  sourceUpdatedAt?: string;
  safeErrorCode?: string;
  createdAt: string;
  metadata: Record<string, string | boolean>;
};

export type PreparedSyncRecord<Mapped> = {
  externalSysId: string;
  externalNumber: string;
  sourceUpdatedAt: string;
  mapped: Mapped;
};

export type SyncDecision = {
  outcome: Exclude<SyncOutcome, "skipped" | "failed">;
  ticketId?: string;
  warningCode?: string;
};

export interface SyncProvider<Raw, Mapped> {
  fetchPage(input: { updatedAfter: string; limit: number; offset: number; signal?: AbortSignal }): Promise<Raw[]>;
  prepare(raw: Raw, now: string): PreparedSyncRecord<Mapped>;
  identify(raw: Raw): { externalSysId?: string; externalNumber?: string };
}

export interface SyncRepository<Mapped> {
  getState(): Promise<SyncState | undefined>;
  createRun(input: {
    id: string;
    mode: SyncMode;
    dryRun: boolean;
    requestedByUserId: string;
    requestId: string;
    correlationId: string;
    startedAt: string;
    watermarkFrom?: string;
  }): Promise<void>;
  finishRun(summary: SyncRunSummary): Promise<void>;
  completeSuccessfulRun(summary: SyncRunSummary, lockToken: string): Promise<boolean>;
  acquireLock(token: string, ttlSeconds: number, now: string): Promise<boolean>;
  releaseLock(token: string): Promise<boolean>;
  preview(mapped: Mapped): Promise<SyncDecision>;
  upsert(mapped: Mapped): Promise<SyncDecision>;
  addRunItem(item: SyncRunItem): Promise<void>;
}

export type SyncEngineOptions<Raw, Mapped> = {
  mode: SyncMode;
  dryRun: boolean;
  requestedByUserId: string;
  requestId: string;
  correlationId: string;
  abortSignal?: AbortSignal;
  initialLookbackDays: number;
  overlapSeconds: number;
  maxRecords: number;
  maxPages: number;
  pageSize: number;
  lockTtlSeconds: number;
  lockRefreshSafetyMs?: number;
  provider: SyncProvider<Raw, Mapped>;
  repository: SyncRepository<Mapped>;
  now?: () => Date;
  createId?: () => string;
};
