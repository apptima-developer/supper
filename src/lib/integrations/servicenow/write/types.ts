import type { JsonObject } from "../../contracts";

export const serviceNowWriteCommandTypes = [
  "create_incident",
  "update_incident",
  "add_comment",
  "add_work_note",
] as const;
export type ServiceNowWriteCommandType = (typeof serviceNowWriteCommandTypes)[number];

export const serviceNowWriteStatuses = [
  "pending",
  "validated",
  "dry_run_ready",
  "executing",
  "succeeded",
  "failed",
  "retry_scheduled",
  "cancelled",
] as const;
export type ServiceNowWriteStatus = (typeof serviceNowWriteStatuses)[number];

export const serviceNowWriteSourceTypes = [
  "manual",
  "supper_ticket",
  "intake_conversation",
  "integration_outbox",
] as const;
export type ServiceNowWriteSourceType = (typeof serviceNowWriteSourceTypes)[number];

export type ServiceNowCreateIncidentInput = {
  shortDescription: string;
  description: string;
  callerId?: string;
  category?: string;
  subcategory?: string;
  impact?: "1" | "2" | "3";
  urgency?: "1" | "2" | "3";
  assignmentGroup?: string;
  contactChannel?: string;
  customer?: string;
  projectCode?: string;
  supperTicketNo?: string;
  externalReferences?: Record<string, string>;
};

export type ServiceNowUpdateIncidentInput = {
  sysId?: string;
  number?: string;
  shortDescription?: string;
  description?: string;
  state?: "1" | "2" | "3" | "6" | "7" | "8";
  impact?: "1" | "2" | "3";
  urgency?: "1" | "2" | "3";
  assignmentGroup?: string;
  customer?: string;
  projectCode?: string;
};

export type ServiceNowJournalInput = {
  sysId?: string;
  number?: string;
  text: string;
};

export type ServiceNowWritePayloadByType = {
  create_incident: ServiceNowCreateIncidentInput;
  update_incident: ServiceNowUpdateIncidentInput;
  add_comment: ServiceNowJournalInput;
  add_work_note: ServiceNowJournalInput;
};

export type ServiceNowWriteCommandInput = {
  [Type in ServiceNowWriteCommandType]: {
    commandType: Type;
    sourceType: ServiceNowWriteSourceType;
    sourceReference: string;
    maxAttempts?: number;
    payload: ServiceNowWritePayloadByType[Type];
  }
}[ServiceNowWriteCommandType];

export type NormalizedServiceNowWriteCommand = {
  commandType: ServiceNowWriteCommandType;
  targetSysId?: string;
  targetNumber?: string;
  fields: Record<string, string>;
};

export type ServiceNowSafeRequestSummary = {
  method: "GET" | "POST" | "PATCH";
  endpointPath: string;
  targetTable: string;
  fieldNames: string[];
  targetSysId?: string;
  targetNumber?: string;
};

export type ServiceNowSafeResponseSummary = {
  httpStatus: number;
  sysId?: string;
  number?: string;
  state?: string;
};

export type ServiceNowWriteAdapterResult = {
  requestSummary: ServiceNowSafeRequestSummary;
  responseSummary: ServiceNowSafeResponseSummary;
  targetSysId: string;
  targetNumber: string;
};

export type ServiceNowWritePreview = {
  commandType: ServiceNowWriteCommandType;
  targetSysId?: string;
  targetNumber?: string;
  fields: Array<{ name: string; kind: "text" | "identifier" | "enum"; length: number; value?: string }>;
};

export type ServiceNowWriteAttemptSummary = {
  id: string;
  attemptNumber: number;
  executionMode: "dry_run" | "live" | "retry";
  requestSummary: JsonObject;
  responseSummary: JsonObject;
  outcome: "executing" | "dry_run" | "succeeded" | "failed";
  safeErrorCode?: string;
  safeErrorMessage?: string;
  startedAt: string;
  finishedAt?: string;
};

export type ServiceNowWriteCommandSummary = {
  id: string;
  commandType: ServiceNowWriteCommandType;
  status: ServiceNowWriteStatus;
  sourceType: ServiceNowWriteSourceType;
  sourceReference: string;
  targetTable: string;
  targetSysId?: string;
  targetNumber?: string;
  validationSummary: JsonObject;
  safeRequestSummary: JsonObject;
  safeResponseSummary: JsonObject;
  errorCode?: string;
  errorMessage?: string;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt?: string;
  lastAttemptAt?: string;
  completedAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  normalizedPreview?: ServiceNowWritePreview;
  attempts?: ServiceNowWriteAttemptSummary[];
  auditWarning?: "secondary_audit_write_failed";
};

export type ServiceNowWriteReadiness = {
  configured: boolean;
  enabled: boolean;
  relationalStorage: boolean;
  ready: boolean;
  authMode?: "basic" | "oauth_client_credentials";
  hostname?: string;
  incidentTable?: string;
  connectionTested?: boolean;
  safeErrorCode?: string;
  safeErrorMessage?: string;
};

export type ServiceNowWriteOperationsSummary = {
  readiness: ServiceNowWriteReadiness;
  latestCommand?: ServiceNowWriteCommandSummary;
  latestDryRun?: ServiceNowWriteAttemptSummary;
  countsByStatus: Partial<Record<ServiceNowWriteStatus, number>>;
  lastSafeErrorCode?: string;
  lastSafeErrorMessage?: string;
};
