import { IntegrationBoundaryError, isIntegrationBoundaryError } from "../../errors";
import type {
  ServiceNowWriteDeliveryDisposition,
  ServiceNowWriteFailurePhase,
} from "./types";

export type ServiceNowWriteExecutionError = IntegrationBoundaryError & {
  readonly deliveryDisposition: ServiceNowWriteDeliveryDisposition;
  readonly failurePhase: ServiceNowWriteFailurePhase;
  readonly retryAllowed: boolean;
  readonly reconciliationReason?: string;
};

export function serviceNowWriteExecutionError(
  error: IntegrationBoundaryError,
  outcome: {
    deliveryDisposition: ServiceNowWriteDeliveryDisposition;
    failurePhase: ServiceNowWriteFailurePhase;
    retryAllowed: boolean;
    reconciliationReason?: string;
  },
) {
  Object.defineProperties(error, {
    deliveryDisposition: { value: outcome.deliveryDisposition, enumerable: false },
    failurePhase: { value: outcome.failurePhase, enumerable: false },
    retryAllowed: { value: outcome.retryAllowed, enumerable: false },
    reconciliationReason: { value: outcome.reconciliationReason, enumerable: false },
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
