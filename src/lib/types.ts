import { z } from "zod";

export const roleSchema = z.enum(["admin", "lead", "support", "sales"]);
export type Role = z.infer<typeof roleSchema>;

export const userSchema = z.object({
  id: z.string(),
  username: z.string(),
  name: z.string(),
  email: z.string().email().or(z.literal("")).default(""),
  passwordHash: z.string(),
  role: roleSchema,
  active: z.boolean().default(true),
});
export type User = z.infer<typeof userSchema>;

export const customerSchema = z.object({
  id: z.string(),
  key: z.string(),
  year: z.number().int(),
  projectCode: z.string(),
  customerName: z.string(),
  contractType: z.string(),
  contractStatus: z.string(),
  mdPurchased: z.number().nonnegative(),
  mdUsed: z.number().nonnegative(),
  mdRemaining: z.number(),
  mdRate: z.number().nonnegative(),
  carryForward: z.number().default(0),
  startPeriod: z.string(),
  endPeriod: z.string(),
  burnRate: z.number().nonnegative(),
  monthlyBurnRate: z.number().nonnegative().optional(),
  mdStatus: z.string(),
  renewalAlert: z.string(),
  aeUpdate: z.string(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Customer = z.infer<typeof customerSchema>;

export const ownerEffortSchema = z.object({
  owner: z.string(),
  hours: z.number().nonnegative(),
});
export type OwnerEffort = z.infer<typeof ownerEffortSchema>;

export const ticketLogSchema = z.object({
  id: z.string(),
  message: z.string(),
  actor: z.string(),
  createdAt: z.string(),
});
export type TicketLog = z.infer<typeof ticketLogSchema>;

export const ticketSchema = z.object({
  id: z.string(),
  issueId: z.string(),
  date: z.string(),
  customerKey: z.string(),
  customerName: z.string(),
  issueTitle: z.string(),
  issueType: z.string(),
  severity: z.string(),
  owner: z.string(),
  ownerEfforts: z.array(ownerEffortSchema).default([]),
  status: z.string(),
  kanbanStatus: z.enum(["open", "in_progress", "waiting", "monitor", "resolved", "closed", "cancelled"]),
  startDate: z.string(),
  dueDate: z.string(),
  closeDate: z.string(),
  mdUsed: z.number(),
  chargeable: z.boolean(),
  remark: z.string(),
  ticketLogs: z.array(ticketLogSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Ticket = z.infer<typeof ticketSchema>;

export const ticketHistorySchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  issueId: z.string(),
  field: z.string(),
  previousValue: z.unknown(),
  nextValue: z.unknown(),
  actor: z.string(),
  source: z.enum(["ui", "excel", "snow", "rollback"]),
  createdAt: z.string(),
});
export type TicketHistory = z.infer<typeof ticketHistorySchema>;

export const auditSchema = z.object({
  id: z.string(),
  action: z.enum(["create", "update", "delete", "import", "restore", "report"]),
  entity: z.string(),
  entityId: z.string(),
  actor: z.string(),
  details: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
});
export type Audit = z.infer<typeof auditSchema>;

export const statusSchema = z.object({
  id: z.string(),
  label: z.string(),
  kanban: z.enum(["open", "in_progress", "waiting", "monitor", "resolved", "closed", "cancelled"]),
  color: z.string().default("slate"),
});
export type Status = z.infer<typeof statusSchema>;

export const slaSchema = z.object({
  id: z.string(),
  customerName: z.string(),
  p1: z.number().positive(),
  p2: z.number().positive(),
  p3: z.number().positive(),
  p4: z.number().positive(),
});
export type Sla = z.infer<typeof slaSchema>;

export const namedMasterSchema = z.object({
  id: z.string(),
  name: z.string(),
  active: z.boolean().default(true),
  lob: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
});
export type NamedMaster = z.infer<typeof namedMasterSchema>;

export const holidaySchema = z.object({ id: z.string(), date: z.string(), name: z.string() });
export type Holiday = z.infer<typeof holidaySchema>;

export const importBatchSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  kind: z.enum(["supportdesk", "snow"]),
  status: z.enum(["completed", "failed", "rolled_back"]),
  summary: z.record(z.string(), z.number()),
  backupPaths: z.array(z.string()).default([]),
  actor: z.string(),
  createdAt: z.string(),
});
export type ImportBatch = z.infer<typeof importBatchSchema>;

export const reportJobSchema = z.object({
  id: z.string(),
  customerKey: z.string(),
  customerName: z.string(),
  month: z.string(),
  status: z.enum(["generated", "failed"]),
  outputPath: z.string(),
  actor: z.string(),
  createdAt: z.string(),
});
export type ReportJob = z.infer<typeof reportJobSchema>;

export const customerListSchema = z.array(customerSchema);
export const ticketListSchema = z.array(ticketSchema);
export const historyListSchema = z.array(ticketHistorySchema);
export const auditListSchema = z.array(auditSchema);
export const statusListSchema = z.array(statusSchema);
export const slaListSchema = z.array(slaSchema);
export const namedMasterListSchema = z.array(namedMasterSchema);
export const holidayListSchema = z.array(holidaySchema);
export const importBatchListSchema = z.array(importBatchSchema);
export const reportJobListSchema = z.array(reportJobSchema);
export const userListSchema = z.array(userSchema);
