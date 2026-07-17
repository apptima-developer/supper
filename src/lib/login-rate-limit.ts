import { createHmac } from "node:crypto";
import { getDataBackend, getRateLimitPepper, isSupabaseBackend } from "./env";

export const loginRateLimitPolicy = {
  maxFailures: 5,
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000,
} as const;

export type LoginRateLimitState = {
  failureCount: number;
  windowStartedAt: string;
  lockedUntil: string | null;
};

export type LoginRateLimitDecision = {
  limited: boolean;
  retryAfterSeconds: number;
  state: LoginRateLimitState | null;
};

export interface LoginRateLimitStore {
  check(keyHash: string, now: Date): Promise<LoginRateLimitDecision>;
  recordFailure(keyHash: string, now: Date): Promise<LoginRateLimitDecision>;
  reset(keyHash: string): Promise<void>;
}

function decision(state: LoginRateLimitState | null, now: Date): LoginRateLimitDecision {
  const lockedUntil = state?.lockedUntil ? new Date(state.lockedUntil) : null;
  const limited = Boolean(lockedUntil && lockedUntil.getTime() > now.getTime());
  return {
    limited,
    retryAfterSeconds: limited ? Math.max(1, Math.ceil((lockedUntil!.getTime() - now.getTime()) / 1000)) : 0,
    state,
  };
}

export function createMemoryLoginRateLimitStore(): LoginRateLimitStore {
  const states = new Map<string, LoginRateLimitState>();
  return {
    async check(keyHash, now) {
      const state = states.get(keyHash) || null;
      if (!state) return decision(null, now);
      const windowExpired = now.getTime() >= new Date(state.windowStartedAt).getTime() + loginRateLimitPolicy.windowMs;
      const lockExpired = !state.lockedUntil || now.getTime() >= new Date(state.lockedUntil).getTime();
      if (windowExpired && lockExpired) {
        states.delete(keyHash);
        return decision(null, now);
      }
      return decision(state, now);
    },
    async recordFailure(keyHash, now) {
      const current = states.get(keyHash);
      const activeLock = current?.lockedUntil && new Date(current.lockedUntil).getTime() > now.getTime();
      if (current && activeLock) return decision(current, now);

      const windowExpired = !current || now.getTime() >= new Date(current.windowStartedAt).getTime() + loginRateLimitPolicy.windowMs;
      const failureCount = windowExpired ? 1 : current.failureCount + 1;
      const next: LoginRateLimitState = {
        failureCount,
        windowStartedAt: windowExpired ? now.toISOString() : current.windowStartedAt,
        lockedUntil: failureCount >= loginRateLimitPolicy.maxFailures
          ? new Date(now.getTime() + loginRateLimitPolicy.lockMs).toISOString()
          : null,
      };
      states.set(keyHash, next);
      return decision(next, now);
    },
    async reset(keyHash) {
      states.delete(keyHash);
    },
  };
}

type RateLimitRow = {
  failure_count: number;
  window_started_at: string;
  locked_until: string | null;
};

function stateFromRow(row: RateLimitRow | null): LoginRateLimitState | null {
  return row ? {
    failureCount: row.failure_count,
    windowStartedAt: row.window_started_at,
    lockedUntil: row.locked_until,
  } : null;
}

function createSupabaseLoginRateLimitStore(): LoginRateLimitStore {
  return {
    async check(keyHash, now) {
      const { supabaseAdmin } = await import("./supabaseAdmin");
      const { data, error } = await supabaseAdmin
        .from("support_login_rate_limits")
        .select("failure_count,window_started_at,locked_until")
        .eq("key_hash", keyHash)
        .maybeSingle();
      if (error) throw new Error(`Login rate-limit check failed: ${error.message}`);
      return decision(stateFromRow(data as RateLimitRow | null), now);
    },
    async recordFailure(keyHash, now) {
      const { supabaseAdmin } = await import("./supabaseAdmin");
      const { data, error } = await supabaseAdmin.rpc("support_record_login_failure", {
        p_key_hash: keyHash,
        p_now: now.toISOString(),
        p_window_seconds: loginRateLimitPolicy.windowMs / 1000,
        p_max_failures: loginRateLimitPolicy.maxFailures,
        p_lock_seconds: loginRateLimitPolicy.lockMs / 1000,
      }).single();
      if (error) throw new Error(`Login rate-limit update failed: ${error.message}`);
      return decision(stateFromRow(data as RateLimitRow), now);
    },
    async reset(keyHash) {
      const { supabaseAdmin } = await import("./supabaseAdmin");
      const { error } = await supabaseAdmin.from("support_login_rate_limits").delete().eq("key_hash", keyHash);
      if (error) throw new Error(`Login rate-limit reset failed: ${error.message}`);
    },
  };
}

const localStore = createMemoryLoginRateLimitStore();

export function getLoginRateLimitStore(): LoginRateLimitStore {
  return isSupabaseBackend() ? createSupabaseLoginRateLimitStore() : localStore;
}

export function createLoginRateLimitKey(identity: string, networkIdentifier: string, pepper = getRateLimitPepper()) {
  const normalizedIdentity = identity.trim().toLocaleLowerCase().slice(0, 320);
  const normalizedNetwork = networkIdentifier.trim().toLocaleLowerCase().slice(0, 200) || "unknown";
  return createHmac("sha256", pepper)
    .update(normalizedIdentity)
    .update("\0")
    .update(normalizedNetwork)
    .digest("hex");
}

export function clientNetworkIdentifier(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim()
    || request.headers.get("x-real-ip")?.trim()
    || "unknown";
}

export function loginRateLimitStorageDescription() {
  return isSupabaseBackend() ? `${getDataBackend()} persistent table` : "local-json in-memory development adapter";
}
