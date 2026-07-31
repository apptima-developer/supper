import { IntegrationBoundaryError, isIntegrationBoundaryError } from "../../errors";
import type {
  ServiceNowSafeResponseSummary,
  ServiceNowWriteDeliveryDisposition,
  ServiceNowWriteFailurePhase,
  ServiceNowWriteMutationCandidateProofStatus,
} from "./types";

export type ServiceNowWriteExecutionError = IntegrationBoundaryError & {
  readonly deliveryDisposition: ServiceNowWriteDeliveryDisposition;
  readonly failurePhase: ServiceNowWriteFailurePhase;
  readonly retryAllowed: boolean;
  readonly reconciliationReason?: string;
  readonly mutationCandidateSysId?: string;
  readonly mutationCandidateNumber?: string;
  readonly mutationHttpStatus?: number;
  readonly mutationCandidateProofStatus?: ServiceNowWriteMutationCandidateProofStatus;
  readonly safeResponseSummary?: ServiceNowSafeResponseSummary;
};

export function serviceNowWriteExecutionError(
  error: IntegrationBoundaryError,
  outcome: {
    deliveryDisposition: ServiceNowWriteDeliveryDisposition;
    failurePhase: ServiceNowWriteFailurePhase;
    retryAllowed: boolean;
    reconciliationReason?: string;
    mutationCandidateSysId?: string;
    mutationCandidateNumber?: string;
    mutationHttpStatus?: number;
    mutationCandidateProofStatus?: ServiceNowWriteMutationCandidateProofStatus;
    safeResponseSummary?: ServiceNowSafeResponseSummary;
  },
) {
  Object.defineProperties(error, {
    deliveryDisposition: { value: outcome.deliveryDisposition, enumerable: false },
    failurePhase: { value: outcome.failurePhase, enumerable: false },
    retryAllowed: { value: outcome.retryAllowed, enumerable: false },
    reconciliationReason: { value: outcome.reconciliationReason, enumerable: false },
    mutationCandidateSysId: { value: outcome.mutationCandidateSysId, enumerable: false },
    mutationCandidateNumber: { value: outcome.mutationCandidateNumber, enumerable: false },
    mutationHttpStatus: { value: outcome.mutationHttpStatus, enumerable: false },
    mutationCandidateProofStatus: {
      value: outcome.mutationCandidateProofStatus,
      enumerable: false,
    },
    safeResponseSummary: { value: outcome.safeResponseSummary, enumerable: false },
  });
  return error as ServiceNowWriteExecutionError;
}

export function isServiceNowWriteExecutionError(value: unknown): value is ServiceNowWriteExecutionError {
  if (!isIntegrationBoundaryError(value)) return false;
  const candidate = value as Partial<ServiceNowWriteExecutionError>;
  return typeof candidate.deliveryDisposition === "string"
    && typeof candidate.failurePhase === "string"
    && typeof candidate.retryAllowed === "boolean";
}
