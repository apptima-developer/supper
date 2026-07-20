import { z } from "zod";
import { boundedMetadataSchema } from "../schemas";

export const serviceNowFieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.object({ value: z.unknown().optional(), display_value: z.unknown().optional(), link: z.string().optional() }).passthrough(),
]);
export const serviceNowRecordSchema = z.record(z.string(), serviceNowFieldValueSchema);
export const serviceNowListResponseSchema = z.object({ result: z.array(serviceNowRecordSchema) }).strict();
export const serviceNowDetailResponseSchema = z.object({ result: serviceNowRecordSchema }).strict();
export const serviceNowOAuthTokenSchema = z.object({
  access_token: z.string().min(1).max(8_192),
  token_type: z.string().default("Bearer"),
  expires_in: z.coerce.number().int().positive().max(86_400).default(3_600),
}).passthrough();

const optionalText = (maximum = 4_000) => z.string().trim().max(maximum).optional();
export const normalizedServiceNowIncidentSchema = z.object({
  provider: z.literal("servicenow"),
  externalSysId: z.string().regex(/^[a-f0-9]{32}$/i),
  number: z.string().trim().min(1).max(100),
  externalUrl: z.string().url(),
  title: z.string().trim().min(1).max(500),
  description: optionalText(20_000),
  state: optionalText(100),
  priority: optionalText(100),
  impact: optionalText(100),
  urgency: optionalText(100),
  customerReference: optionalText(500),
  callerReference: optionalText(500),
  assignedUserReference: optionalText(500),
  assignmentGroupReference: optionalText(500),
  category: optionalText(200),
  subcategory: optionalText(200),
  openedAt: z.string().datetime().optional(),
  resolvedAt: z.string().datetime().optional(),
  closedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime().optional(),
  lastUpdatedAt: z.string().datetime().optional(),
  providerMetadata: boundedMetadataSchema,
}).strict();
export type NormalizedServiceNowIncident = z.infer<typeof normalizedServiceNowIncidentSchema>;

export const incidentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  number: z.string().trim().regex(/^[A-Z0-9_-]{1,40}$/).optional(),
  updatedAfter: z.string().datetime({ offset: true }).optional(),
}).strict();

export const serviceNowAdapterListQuerySchema = incidentListQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(1_000),
});

export const serviceNowSysIdSchema = z.string().regex(/^[a-f0-9]{32}$/i);
