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
  "reconciliation_required",
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

export const serviceNowWriteDeliveryDispositions = [
  "definitely_not_sent",
  "definitely_rejected",
  "safe_to_retry",
  "confirmed_succeeded",
  "may_have_committed",
] as const;
export type ServiceNowWriteDeliveryDisposition = (typeof serviceNowWriteDeliveryDispositions)[number];

export const serviceNowWriteFailurePhases = [
  "configuration",
  "authorization",
  "number_lookup",
  "mutation_dispatch",
  "mutation_response",
  "response_parse",
  "read_back",
] as const;
export type ServiceNowWriteFailurePhase = (typeof serviceNowWriteFailurePhases)[number];

export const serviceNowWriteReconciliationActions = [
  "reconcile_by_read_back",
  "mark_succeeded_after_verification",
  "mark_not_applied_after_verification",
] as const;
export type ServiceNowWriteReconciliationAction = (typeof serviceNowWriteReconciliationActions)[number];

export const serviceNowWriteEvidenceClassifications = [
  "provider_matched",
  "provider_not_found",
  "provider_ambiguous",
  "provider_inconclusive",
  "provider_target_conflict",
  "provider_unavailable",
  "provider_unavailable_manual_verification",
  "provider_target_matched_manual_verification",
  "journal_manual_verification",
] as const;
export type ServiceNowWriteEvidenceClassification = (typeof serviceNowWriteEvidenceClassifications)[number];

export const serviceNowWriteReconciliationResults = [
  "confirmed_succeeded",
  "confirmed_not_applied",
  "not_found",
  "ambiguous",
  "inconclusive",
  "read_back_failed",
] as const;
export type ServiceNowWriteReconciliationResult = (typeof serviceNowWriteReconciliationResults)[number];

export const serviceNowWriteMutationCandidateProofStatuses = [
  "marker_verified",
  "marker_not_verified",
  "marker_not_found",
  "marker_ambiguous",
  "marker_target_conflict",
  "marker_verification_unavailable",
] as const;
export type ServiceNowWriteMutationCandidateProofStatus =
  (typeof serviceNowWriteMutationCandidateProofStatuses)[number];

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
    sourceEntityReference?: string;
    operationReference?: string;
    manualOperationToken?: string;
    maxAttempts?: number;
    payload: ServiceNowWritePayloadByType[Type];
  }
}[ServiceNowWriteCommandType];

export type ServiceNowManualOperationIdentity = {
  operationToken: string;
  operationReference: string;
  expiresAt: string;
};

export type NormalizedServiceNowWriteCommand = {
  schemaVersion: "servicenow-write-normalized-v2";
  commandType: ServiceNowWriteCommandType;
  targetSysId?: string;
  targetNumber?: string;
  providerCorrelationMarker?: string;
  fields: Record<string, string>;
};

export type ServiceNowSafeRequestSummary = {
  method: "GET" | "POST" | "PATCH";
  endpointPath: string;
  targetTable: string;
  fieldNames: string[];
  targetSysId?: string;
  targetNumber?: string;
  lookupClassification?: "correlation_marker_exact";
  lookupCorrelationMarkerHash?: string;
};

export type ServiceNowSafeResponseSummary = {
  httpStatus: number;
  sysId?: string;
  number?: string;
  state?: string;
  recoveredByCorrelationMarker?: boolean;
  providerWritePerformed?: boolean;
  exactMarkerVerified?: boolean;
  mutationCandidateObserved?: boolean;
  candidateSysId?: string;
  candidateNumber?: string;
  mutationHttpStatus?: number;
  postWriteMarkerVerified?: boolean;
  postWriteLookupHttpStatus?: number;
  postWriteLookupCorrelationMarkerHash?: string;
  postWriteVerifiedCorrelationMarkerHash?: string;
  verifiedCorrelationMarkerHash?: string;
};

export type ServiceNowWriteMutationCandidate = {
  id: string;
  attemptId: string;
  attemptNumber: number;
  sysId: string;
  number: string;
  httpStatus: number;
  observedAt: string;
  source: "mutation_response";
  proofStatus: ServiceNowWriteMutationCandidateProofStatus;
  resolutionState: "current_unresolved" | "confirmed_succeeded" | "confirmed_not_applied";
  reconciliationResult?: ServiceNowWriteReconciliationResult;
};

export type ServiceNowWriteAdapterResult = {
  requestSummary: ServiceNowSafeRequestSummary;
  responseSummary: ServiceNowSafeResponseSummary;
  targetSysId: string;
  targetNumber: string;
  mutationCandidate?: Pick<
    ServiceNowWriteMutationCandidate,
    "sysId" | "number" | "httpStatus" | "source" | "proofStatus"
  >;
};

export type ServiceNowWriteReadBackResult = {
  result: "confirmed_succeeded" | "not_found" | "ambiguous" | "inconclusive";
  summary: JsonObject;
  targetSysId?: string;
  targetNumber?: string;
};

export type ServiceNowWritePreview = {
  commandType: ServiceNowWriteCommandType;
  targetSysId?: string;
  targetNumber?: string;
  providerCorrelationMarker?: string;
  fields: Array<{ name: string; kind: "text" | "identifier" | "enum"; length: number; value?: string }>;
};

export type ServiceNowWriteAttemptSummary = {
  id: string;
  attemptNumber: number;
  executionMode: "dry_run" | "live" | "retry";
  requestSummary: JsonObject;
  responseSummary: JsonObject;
  outcome: "executing" | "dry_run" | "succeeded" | "failed" | "uncertain";
  deliveryDisposition?: ServiceNowWriteDeliveryDisposition;
  failurePhase?: ServiceNowWriteFailurePhase;
  retryAllowed: boolean;
  retryReason?: string;
  reconciliationReason?: string;
  safeErrorCode?: string;
  safeErrorMessage?: string;
  startedAt: string;
  attemptStartedAt: string;
  recoverableAt: string;
  providerRequestBudget: number;
  recoveryBudgetMs: number;
  recoveryEligible: boolean;
  finishedAt?: string;
};

export type ServiceNowWriteReconciliationEventSummary = {
  id: string;
  mutationCandidateEventId?: string;
  action: ServiceNowWriteReconciliationAction;
  result: ServiceNowWriteReconciliationResult;
  evidenceClassification: ServiceNowWriteEvidenceClassification;
  safeReadBackSummary: JsonObject;
  actorUserId: string;
  commandVersionBefore: number;
  commandVersionAfter: number;
  createdAt: string;
};

export type ServiceNowWriteCommandSummary = {
  id: string;
  version: number;
  commandType: ServiceNowWriteCommandType;
  status: ServiceNowWriteStatus;
  sourceType: ServiceNowWriteSourceType;
  sourceEntityReference?: string;
  operationReference: string;
  targetTable: string;
  targetSysId?: string;
  targetNumber?: string;
  mutationCandidate?: ServiceNowWriteMutationCandidate;
  mutationCandidateHistory?: ServiceNowWriteMutationCandidate[];
  commandMaterialHash: string;
  normalizedPayloadHash: string;
  providerCorrelationMarker?: string;
  validationSummary: JsonObject;
  safeRequestSummary: JsonObject;
  safeResponseSummary: JsonObject;
  deliveryDisposition?: ServiceNowWriteDeliveryDisposition;
  failurePhase?: ServiceNowWriteFailurePhase;
  retryAllowed: boolean;
  retryReason?: string;
  reconciliationReason?: string;
  reconciliationCheckedAt?: string;
  reconciledByUserId?: string;
  reconciliationResult?: ServiceNowWriteReconciliationResult;
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
  reconciliationHistory?: ServiceNowWriteReconciliationEventSummary[];
  recoveryHistory?: ServiceNowWriteAttemptRecoverySummary[];
  auditWarning?: "secondary_audit_write_failed";
};

export type ServiceNowWriteReadiness = {
  configured: boolean;
  relationalStorage: boolean;
  connectionTestable: boolean;
  connectionTested: boolean;
  connectionTestExpired: boolean;
  liveWriteEnabled: boolean;
  liveWriteReady: boolean;
  configurationFingerprint?: string;
  testedAt?: string;
  proofExpiresAt?: string;
  testStatus?: "succeeded" | "failed";
  safeHttpStatus?: number;
  authMode?: "basic" | "oauth_client_credentials";
  hostname?: string;
  incidentTable?: string;
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

export type ServiceNowWriteConfirmation = {
  confirmationNonce: string;
  action: "execute" | "retry" | "recover_stuck_attempt" | ServiceNowWriteReconciliationAction;
  commandId: string;
  expectedVersion: number;
  expectedNormalizedPayloadHash: string;
  mutationCandidateEventId?: string;
  expiresAt: string;
};

export type ServiceNowWriteAttemptRecoverySummary = {
  id: string;
  attemptId: string;
  attemptNumber: number;
  actorUserId: string;
  commandVersionBefore: number;
  commandVersionAfter: number;
  createdAt: string;
};
