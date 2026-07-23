import { z } from "zod";
import { disabledByDefaultBooleanSchema, environmentValueOrDefault } from "../env-normalization";

const writeConfigSchema = z.object({
  enabled: disabledByDefaultBooleanSchema,
  maxAttempts: z.coerce.number().int().min(1).max(10),
}).strict();

export type ServiceNowWriteConfig = z.infer<typeof writeConfigSchema>;

export function parseServiceNowWriteConfig(env: Record<string, string | undefined>): ServiceNowWriteConfig {
  return writeConfigSchema.parse({
    enabled: env.SERVICENOW_WRITE_ENABLED,
    maxAttempts: environmentValueOrDefault(env.SERVICENOW_WRITE_MAX_ATTEMPTS, 3),
  });
}
