import { z } from "zod";
import { disabledByDefaultBooleanSchema, environmentValueOrDefault } from "../env-normalization";

const integer = (minimum: number, maximum: number) => z.coerce.number().int().min(minimum).max(maximum);
const syncConfigSchema = z.object({
  enabled: disabledByDefaultBooleanSchema,
  initialLookbackDays: integer(1, 365),
  overlapSeconds: integer(0, 900),
  maxRecords: integer(1, 5_000),
  maxPages: integer(1, 100),
  lockTtlSeconds: integer(30, 1_800),
}).strict();

export type ServiceNowSyncConfig = z.infer<typeof syncConfigSchema>;

export function parseServiceNowSyncConfig(env: Record<string, string | undefined>): ServiceNowSyncConfig {
  return syncConfigSchema.parse({
    enabled: env.SERVICENOW_SYNC_ENABLED,
    initialLookbackDays: environmentValueOrDefault(env.SERVICENOW_SYNC_INITIAL_LOOKBACK_DAYS, 30),
    overlapSeconds: environmentValueOrDefault(env.SERVICENOW_SYNC_OVERLAP_SECONDS, 120),
    maxRecords: environmentValueOrDefault(env.SERVICENOW_SYNC_MAX_RECORDS, 1_000),
    maxPages: environmentValueOrDefault(env.SERVICENOW_SYNC_MAX_PAGES, 20),
    lockTtlSeconds: environmentValueOrDefault(env.SERVICENOW_SYNC_LOCK_TTL_SECONDS, 300),
  });
}
