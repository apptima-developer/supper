import type { Session } from "../../auth";
import { can } from "../../rbac";
import { jsonResponseWithRequestId, requestId, safeErrorResponse } from "../../request-security";
import { logServerError } from "../../server-logging";
import { correlationIdSchema } from "../schemas";
import { isIntegrationBoundaryError } from "../errors";
import { serviceNowErrorHttpStatus } from "./errors";
import { incidentListQuerySchema, serviceNowSysIdSchema } from "./schemas";
import type { ServiceNowReadOnlyAdapter } from "./adapter";

export type ServiceNowApiDependencies = {
  getSession: () => Promise<Session | null>;
  getAdapter: () => Pick<ServiceNowReadOnlyAdapter, "testConnection" | "listIncidents" | "getIncidentBySysId">;
};

function authorizationResponse(session: Session | null, request: Request) {
  if (!session) return jsonResponseWithRequestId({ error: "Unauthorized", code: "UNAUTHORIZED" }, request, { status: 401 });
  if (!can(session.role, "settings:manage")) return jsonResponseWithRequestId({ error: "Forbidden", code: "FORBIDDEN" }, request, { status: 403 });
  return null;
}

function providerErrorResponse(error: unknown, request: Request, operation: string, correlationId: string) {
  if (!isIntegrationBoundaryError(error)) return safeErrorResponse(error, "ServiceNow request failed", request, 500, correlationId);
  logServerError("servicenow_read_failed", error.toLog(), { requestId: correlationId, route: new URL(request.url).pathname, operation });
  return jsonResponseWithRequestId({
    error: error.safeMessage,
    code: error.code,
    category: error.category,
    retryable: error.retryable,
  }, request, { status: serviceNowErrorHttpStatus(error) }, correlationId);
}

export async function handleServiceNowTest(request: Request, dependencies: ServiceNowApiDependencies) {
  const correlationId = requestId(request);
  try {
    const denied = authorizationResponse(await dependencies.getSession(), request);
    if (denied) return denied;
    const result = await dependencies.getAdapter().testConnection(correlationIdSchema.parse(correlationId), request.signal);
    return jsonResponseWithRequestId(result, request, {}, correlationId);
  } catch (error) {
    return providerErrorResponse(error, request, "provider.test", correlationId);
  }
}

export async function handleServiceNowIncidentList(request: Request, dependencies: ServiceNowApiDependencies) {
  const correlationId = requestId(request);
  try {
    const denied = authorizationResponse(await dependencies.getSession(), request);
    if (denied) return denied;
    const url = new URL(request.url);
    const query = incidentListQuerySchema.parse(Object.fromEntries(url.searchParams));
    const result = await dependencies.getAdapter().listIncidents(query, correlationIdSchema.parse(correlationId), request.signal);
    return jsonResponseWithRequestId({ items: result.incidents, count: result.incidents.length, pageCount: result.pageCount }, request, {}, correlationId);
  } catch (error) {
    return providerErrorResponse(error, request, "ticket.list", correlationId);
  }
}

export async function handleServiceNowIncidentDetail(request: Request, sysId: string, dependencies: ServiceNowApiDependencies) {
  const correlationId = requestId(request);
  try {
    const denied = authorizationResponse(await dependencies.getSession(), request);
    if (denied) return denied;
    const safeSysId = serviceNowSysIdSchema.parse(sysId);
    const incident = await dependencies.getAdapter().getIncidentBySysId(safeSysId, correlationIdSchema.parse(correlationId), request.signal);
    return jsonResponseWithRequestId({ item: incident }, request, {}, correlationId);
  } catch (error) {
    return providerErrorResponse(error, request, "ticket.read", correlationId);
  }
}
