import { z } from "zod";
import { assertNoSensitiveIntakeData } from "@/lib/intake-core/sensitive-data";
import { containsControlCharacters } from "@/lib/integrations/validation";
import { serviceNowWriteCommandTypes, serviceNowWriteSourceTypes, serviceNowWriteStatuses } from "./types";

const safeText = (label: string, maximum: number, required = false) => {
  const schema = z.string().trim().max(maximum, `${label} is too long`)
    .refine((value) => !containsControlCharacters(value), `${label} contains control characters`);
  return required ? schema.min(1, `${label} is required`) : schema;
};
const optionalText = (label: string, maximum: number) => safeText(label, maximum).optional()
  .transform((value) => value || undefined);

export const serviceNowWriteCommandTypeSchema = z.enum(serviceNowWriteCommandTypes);
export const serviceNowWriteStatusSchema = z.enum(serviceNowWriteStatuses);
export const serviceNowWriteSourceTypeSchema = z.enum(serviceNowWriteSourceTypes);
export const serviceNowWriteCommandIdSchema = z.string().trim().min(16).max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, "Invalid command ID");
export const serviceNowSysIdWriteSchema = z.string().trim().regex(/^[a-f0-9]{32}$/, "Invalid ServiceNow sys_id");
export const serviceNowNumberWriteSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,80}$/, "Invalid ServiceNow number");

const boundedIdentifier = (label: string) => safeText(label, 500).optional()
  .transform((value) => value || undefined);
const impactUrgency = z.enum(["1", "2", "3"]);
const incidentState = z.enum(["1", "2", "3", "6", "7", "8"]);

const externalReferencesSchema = z.record(
  z.string().trim().min(1).max(80).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
  safeText("External reference", 500, true),
).superRefine((value, context) => {
  if (Object.keys(value).length > 20 || Buffer.byteLength(JSON.stringify(value), "utf8") > 8192) {
    context.addIssue({ code: "custom", message: "External references are too large" });
  }
  try {
    assertNoSensitiveIntakeData(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "External references contain unsafe data",
    });
  }
}).optional();

export const serviceNowCreateIncidentInputSchema = z.object({
  shortDescription: safeText("Short description", 160, true),
  description: safeText("Description", 20_000, true),
  callerId: boundedIdentifier("Caller"),
  category: optionalText("Category", 100),
  subcategory: optionalText("Subcategory", 100),
  impact: impactUrgency.optional(),
  urgency: impactUrgency.optional(),
  assignmentGroup: boundedIdentifier("Assignment group"),
  contactChannel: optionalText("Contact channel", 100),
  customer: boundedIdentifier("Customer"),
  projectCode: optionalText("Project code", 200),
  supperTicketNo: optionalText("SUPPER ticket number", 100),
  externalReferences: externalReferencesSchema,
}).strict();

export const serviceNowUpdateIncidentInputSchema = z.object({
  sysId: serviceNowSysIdWriteSchema.optional(),
  number: serviceNowNumberWriteSchema.optional(),
  shortDescription: optionalText("Short description", 160),
  description: optionalText("Description", 20_000),
  state: incidentState.optional(),
  impact: impactUrgency.optional(),
  urgency: impactUrgency.optional(),
  assignmentGroup: boundedIdentifier("Assignment group"),
  customer: boundedIdentifier("Customer"),
  projectCode: optionalText("Project code", 200),
}).strict().superRefine((value, context) => {
  if (!value.sysId && !value.number) context.addIssue({ code: "custom", message: "sysId or number is required", path: ["sysId"] });
  const fields = Object.keys(value).filter((key) => key !== "sysId" && key !== "number");
  if (!fields.length) context.addIssue({ code: "custom", message: "At least one update field is required", path: ["shortDescription"] });
});

export const serviceNowJournalInputSchema = z.object({
  sysId: serviceNowSysIdWriteSchema.optional(),
  number: serviceNowNumberWriteSchema.optional(),
  text: safeText("Journal text", 20_000, true),
}).strict().superRefine((value, context) => {
  if (!value.sysId && !value.number) context.addIssue({ code: "custom", message: "sysId or number is required", path: ["sysId"] });
});

const commonCommand = {
  sourceType: serviceNowWriteSourceTypeSchema,
  sourceReference: safeText("Source reference", 500, true),
  maxAttempts: z.number().int().min(1).max(10).optional(),
};

export const createServiceNowWriteCommandRequestSchema = z.discriminatedUnion("commandType", [
  z.object({ commandType: z.literal("create_incident"), ...commonCommand, payload: serviceNowCreateIncidentInputSchema }).strict(),
  z.object({ commandType: z.literal("update_incident"), ...commonCommand, payload: serviceNowUpdateIncidentInputSchema }).strict(),
  z.object({ commandType: z.literal("add_comment"), ...commonCommand, payload: serviceNowJournalInputSchema }).strict(),
  z.object({ commandType: z.literal("add_work_note"), ...commonCommand, payload: serviceNowJournalInputSchema }).strict(),
]);

const optionalDate = z.string().date().optional();
export const serviceNowWriteCommandsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: serviceNowWriteStatusSchema.optional(),
  commandType: serviceNowWriteCommandTypeSchema.optional(),
  dateFrom: optionalDate,
  dateTo: optionalDate,
}).strict();

export function queryObject(request: Request) {
  return Object.fromEntries(new URL(request.url).searchParams.entries());
}
