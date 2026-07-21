import { z } from "zod";

const optionalDate = z.string().date().optional();
const page = z.coerce.number().int().min(1).max(100_000).default(1);
const limit = z.coerce.number().int().min(1).max(100).default(25);

export const serviceNowRunsQuerySchema = z.object({
  page,
  limit,
  status: z.enum(["running", "succeeded", "partial", "failed", "blocked"]).optional(),
  mode: z.enum(["initial", "incremental"]).optional(),
  dryRun: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  dateFrom: optionalDate,
  dateTo: optionalDate,
}).strict();

export const serviceNowRunDetailQuerySchema = z.object({
  itemCursor: z.coerce.number().int().min(0).max(1_000_000).default(0),
  itemLimit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export const serviceNowMappingQuerySchema = z.object({
  page,
  limit,
  status: z.enum(["all", "mapped", "unmapped", "inactive"]).default("all"),
  search: z.string().trim().max(200).default(""),
}).strict();

export const serviceNowApplyMappingSchema = z.object({
  externalCustomerKey: z.string().trim().min(1).max(600)
    .refine((value) => value.startsWith("servicenow-unmapped:"), "Invalid ServiceNow customer key"),
  customerKey: z.string().trim().min(1).max(600),
}).strict();

export const serviceNowMappingIdSchema = z.string().trim().min(16).max(200);

export const serviceNowCustomerTargetsQuerySchema = z.object({
  search: z.string().trim().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(50).default(25),
}).strict();

export function queryObject(request: Request) {
  return Object.fromEntries(new URL(request.url).searchParams.entries());
}
