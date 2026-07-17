import { z } from "zod";
import { roleSchema } from "./types";

const shortText = z.string().trim().max(500);
const requiredText = z.string().trim().min(1).max(500);
const longText = z.string().max(20_000);
const dateText = z.string().max(50);

export const passwordSchema = z.string()
  .min(12, "Password must be at least 12 characters")
  .refine((value) => value.trim().length > 0, "Password cannot contain only whitespace");

function rejectIdentityPassword(
  input: { username: string; email: string; password?: string },
  context: z.RefinementCtx,
) {
  if (!input.password) return;
  const password = input.password.toLocaleLowerCase();
  if (password === input.username.toLocaleLowerCase() || password === input.email.toLocaleLowerCase()) {
    context.addIssue({ code: "custom", path: ["password"], message: "Password cannot equal the username or email" });
  }
}

export const accountCreateSchema = z.object({
  username: z.string().trim().min(3).max(100),
  password: passwordSchema,
  email: z.string().trim().email().max(320),
  role: roleSchema,
  active: z.boolean().default(true),
}).strict().superRefine(rejectIdentityPassword);

export const accountUpdateSchema = z.object({
  username: z.string().trim().min(3).max(100),
  password: z.union([z.literal(""), passwordSchema]).optional(),
  email: z.string().trim().email().max(320),
  role: roleSchema,
  active: z.boolean(),
}).strict().superRefine(rejectIdentityPassword);

export const customerCreateSchema = z.object({
  year: z.number().int().min(2000).max(2200),
  projectCode: requiredText,
  customerName: requiredText,
  contractType: requiredText,
  contractStatus: requiredText,
  mdPurchased: z.number().nonnegative(),
  carryForward: z.number().nonnegative(),
  mdRate: z.number().nonnegative(),
  startPeriod: dateText,
  endPeriod: dateText,
  renewalAlert: shortText,
  aeUpdate: longText,
  active: z.boolean(),
}).strict();

export const customerUpdateSchema = customerCreateSchema.partial().strict();
export const customerAeUpdateSchema = z.object({ aeUpdate: longText }).strict();

const ownerEffortInputSchema = z.object({
  owner: shortText,
  hours: z.number().nonnegative().finite(),
}).strict();

const ticketLogAttachmentInputSchema = z.object({
  id: z.string().min(1).max(200),
  fileName: requiredText,
  contentType: requiredText,
  dataUrl: z.string().min(1),
}).strict();

const ticketLogInputSchema = z.object({
  message: longText,
  attachments: z.array(ticketLogAttachmentInputSchema).max(4).default([]),
}).strict();

const ticketMutableShape = {
  customerKey: requiredText,
  issueTitle: requiredText,
  issueType: requiredText,
  category: shortText,
  severity: requiredText,
  ownerEfforts: z.array(ownerEffortInputSchema).max(50),
  status: requiredText,
  startDate: dateText,
  closeDate: dateText,
  chargeable: z.boolean(),
  remark: longText.optional(),
  logEntry: ticketLogInputSchema.optional(),
};

export const ticketCreateSchema = z.object({
  issueId: requiredText,
  ...ticketMutableShape,
}).strict();

export const ticketUserUpdateSchema = z.object(ticketMutableShape).partial().strict();

export const backupRestoreSchema = z.object({ backup: z.string().min(1).max(500) }).strict();
export const reportCreateSchema = z.object({ customerKey: requiredText, month: z.string().regex(/^\d{4}-\d{2}$/) }).strict();
export const monthlyExportSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  projectCode: requiredText,
  force: z.boolean().optional().default(false),
}).strict();

export const statusMutationListSchema = z.array(z.object({
  id: z.string().min(1).max(200),
  label: requiredText,
  kanban: z.enum(["open", "in_progress", "waiting", "monitor", "resolved", "closed", "cancelled"]),
  color: shortText.default("slate"),
}).strict()).max(10_000);

export const slaMutationListSchema = z.array(z.object({
  id: z.string().min(1).max(200),
  customerName: requiredText,
  p1: z.number().positive(),
  p2: z.number().positive(),
  p3: z.number().positive(),
  p4: z.number().positive(),
}).strict()).max(10_000);

export const holidayMutationListSchema = z.array(z.object({
  id: z.string().min(1).max(200),
  date: dateText,
  name: requiredText,
}).strict()).max(10_000);

export const namedMasterMutationListSchema = z.array(z.object({
  id: z.string().min(1).max(200),
  name: requiredText,
  active: z.boolean().default(true),
  lob: shortText.optional(),
  email: z.string().max(320).optional(),
  phone: shortText.optional(),
}).strict()).max(10_000);

export const categoryMutationListSchema = z.array(z.object({
  id: z.string().min(1).max(200),
  customerKey: shortText.default(""),
  customerName: shortText.default(""),
  category: requiredText,
  active: z.boolean().default(true),
}).strict()).max(10_000);
