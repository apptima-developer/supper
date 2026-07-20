import { IntegrationBoundaryError } from "../errors";
import type { IntegrationCorrelationId, IntegrationErrorCategory, IntegrationOperation } from "../contracts";

export function serviceNowError(options: {
  category: IntegrationErrorCategory;
  code: string;
  safeMessage: string;
  retryable: boolean;
  operation: IntegrationOperation;
  correlationId: IntegrationCorrelationId;
  cause?: unknown;
}) {
  return new IntegrationBoundaryError({ ...options, provider: "servicenow" });
}

export function mapServiceNowHttpError(status: number, operation: IntegrationOperation, correlationId: IntegrationCorrelationId) {
  const definitions: Record<number, [IntegrationErrorCategory, string, string, boolean]> = {
    400: ["validation", "SERVICENOW_BAD_REQUEST", "ServiceNow rejected the read request", false],
    401: ["authentication", "SERVICENOW_AUTHENTICATION_FAILED", "ServiceNow authentication failed", false],
    403: ["authorization", "SERVICENOW_ACCESS_DENIED", "ServiceNow denied access to the requested records", false],
    404: ["validation", "SERVICENOW_NOT_FOUND", "The requested ServiceNow record was not found", false],
    409: ["conflict", "SERVICENOW_CONFLICT", "ServiceNow could not complete the read request", true],
    429: ["rate_limit", "SERVICENOW_RATE_LIMITED", "ServiceNow temporarily rate limited the request", true],
  };
  const [category, code, safeMessage, retryable] = definitions[status]
    || (status >= 500
      ? ["unavailable", "SERVICENOW_UNAVAILABLE", "ServiceNow is temporarily unavailable", true] as const
      : ["unavailable", "SERVICENOW_REQUEST_FAILED", "ServiceNow could not complete the request", false] as const);
  return serviceNowError({ category, code, safeMessage, retryable, operation, correlationId });
}

export function serviceNowErrorHttpStatus(error: IntegrationBoundaryError) {
  if (error.category === "validation") return error.code === "SERVICENOW_NOT_FOUND" ? 404 : 400;
  if (error.category === "rate_limit") return 429;
  if (error.category === "timeout") return 504;
  if (error.category === "unavailable") return 503;
  if (error.category === "conflict") return 409;
  if (error.category === "malformed_response") return 502;
  return 502;
}
