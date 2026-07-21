import type { ServiceNowConfigSummary } from "../config";

export type ServiceNowRunSummary = {
  runId: string;
  mode: string;
  status: string;
  dryRun: boolean;
  startedAt?: string;
  completedAt?: string;
  watermarkFrom?: string;
  watermarkFromSysId?: string;
  watermarkTo?: string;
  watermarkToSysId?: string;
  windowStart?: string;
  windowEnd?: string;
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  stale: number;
  skipped: number;
  failed: number;
  pages: number;
  duration: number;
  safeErrorCategory?: string;
  auditWarning?: string;
};

export type ServiceNowRunItem = {
  externalNumber?: string;
  ticketId?: string;
  outcome: string;
  sourceUpdatedAt?: string;
  safeErrorCode?: string;
  warningCode?: string;
};

export type ServiceNowMappingCandidate = {
  mappingId?: string;
  externalCustomerKey: string;
  externalCustomerId?: string;
  externalCustomerName: string;
  mappable: boolean;
  mapped: boolean;
  activeMapping: boolean;
  mappedCustomerKey?: string;
  mappedCustomerName?: string;
  ticketCount: number;
  openTicketCount: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
  exampleIncidents: string[];
};

export type ServiceNowMappingResult = {
  mappingId: string;
  action: "created" | "changed" | "reactivated" | "unchanged" | "deactivated";
  previousCustomerKey?: string;
  customerKey: string;
  customerName?: string;
  affectedTicketCount: number;
  active: boolean;
  auditWarning?: "secondary_audit_write_failed";
};

export type ServiceNowOperationsSummary = {
  config: ServiceNowConfigSummary;
  syncEnabled: boolean;
  syncRunning: boolean;
  currentWatermark?: string;
  currentWatermarkSysId?: string;
  lastAttempt?: string;
  lastSuccess?: string;
  latestRun?: ServiceNowRunSummary;
  runsLast24Hours: number;
  failedOrPartialRunsLast24Hours: number;
  unmappedCustomerSourceCount: number;
  unmappedTicketCount: number;
  activeMappingCount: number;
  inactiveMappingCount: number;
};
