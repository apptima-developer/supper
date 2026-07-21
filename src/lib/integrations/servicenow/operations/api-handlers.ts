import type { Session } from "../../../auth";
import { can } from "../../../rbac";
import { HttpError, jsonResponseWithRequestId, readJsonBody, readLimitedBodyBytes, requestId, safeErrorResponse } from "../../../request-security";
import { applyServiceNowCustomerMapping, deactivateServiceNowCustomerMapping, getServiceNowOperationsSummary } from "./service";
import { ServiceNowOperationsRepository } from "./repository";
import {
  queryObject, serviceNowApplyMappingSchema, serviceNowCustomerTargetsQuerySchema,
  serviceNowMappingIdSchema, serviceNowMappingQuerySchema, serviceNowRunDetailQuerySchema, serviceNowRunsQuerySchema,
} from "./schemas";

export type ServiceNowOperationsApiDependencies = {
  getSession: () => Promise<Session | null>;
  repository?: ServiceNowOperationsRepository;
  summary?: typeof getServiceNowOperationsSummary;
  apply?: typeof applyServiceNowCustomerMapping;
  deactivate?: typeof deactivateServiceNowCustomerMapping;
};

function authorize(session: Session | null, request: Request, correlationId: string) {
  if (!session) return jsonResponseWithRequestId({ error: "Unauthorized", code: "UNAUTHORIZED" }, request, { status: 401 }, correlationId);
  if (!can(session.role, "settings:manage")) return jsonResponseWithRequestId({ error: "Forbidden", code: "FORBIDDEN" }, request, { status: 403 }, correlationId);
  return null;
}

async function authorized(request: Request, dependencies: ServiceNowOperationsApiDependencies, handler: (session: Session, correlationId: string, repository: ServiceNowOperationsRepository) => Promise<Response>) {
  const correlationId = requestId(request);
  try {
    const session = await dependencies.getSession();
    const denied = authorize(session, request, correlationId);
    if (denied) return denied;
    if (!session) throw new HttpError(401, "UNAUTHORIZED", "Unauthorized");
    return await handler(session, correlationId, dependencies.repository || new ServiceNowOperationsRepository());
  } catch (error) {
    return safeErrorResponse(error, "ServiceNow operations request failed", request, 500, correlationId);
  }
}

export function handleServiceNowOperationsGet(request: Request, dependencies: ServiceNowOperationsApiDependencies) {
  return authorized(request, dependencies, async (_session, correlationId, repository) => {
    const summary = await (dependencies.summary || getServiceNowOperationsSummary)(repository);
    return jsonResponseWithRequestId(summary, request, {}, correlationId);
  });
}

export function handleServiceNowRunsGet(request: Request, dependencies: ServiceNowOperationsApiDependencies) {
  return authorized(request, dependencies, async (_session, correlationId, repository) => {
    const result = await repository.listRuns(serviceNowRunsQuerySchema.parse(queryObject(request)));
    return jsonResponseWithRequestId(result, request, {}, correlationId);
  });
}

export function handleServiceNowRunDetailGet(request: Request, runId: string, dependencies: ServiceNowOperationsApiDependencies) {
  return authorized(request, dependencies, async (_session, correlationId, repository) => {
    const safeRunId = serviceNowMappingIdSchema.parse(runId);
    const query = serviceNowRunDetailQuerySchema.parse(queryObject(request));
    const result = await repository.readRunDetail(safeRunId, query.itemCursor, query.itemLimit);
    if (!result.run) throw new HttpError(404, "SERVICENOW_SYNC_RUN_NOT_FOUND", "Synchronization run was not found");
    return jsonResponseWithRequestId(result, request, {}, correlationId);
  });
}

export function handleServiceNowCustomerMappingsGet(request: Request, dependencies: ServiceNowOperationsApiDependencies) {
  return authorized(request, dependencies, async (_session, correlationId, repository) => {
    const result = await repository.listMappingCandidates(serviceNowMappingQuerySchema.parse(queryObject(request)));
    return jsonResponseWithRequestId({ ...result, filters: ["all", "mapped", "unmapped", "inactive"] }, request, {}, correlationId);
  });
}

export function handleServiceNowCustomerMappingsPost(request: Request, dependencies: ServiceNowOperationsApiDependencies) {
  return authorized(request, dependencies, async (session, correlationId, repository) => {
    const body = await readJsonBody(request, serviceNowApplyMappingSchema, 4 * 1024);
    const result = await (dependencies.apply || applyServiceNowCustomerMapping)({ ...body, session, requestId: correlationId, correlationId }, { repository });
    return jsonResponseWithRequestId(result, request, {}, correlationId);
  });
}

export function handleServiceNowMappingDeactivatePost(request: Request, mappingId: string, dependencies: ServiceNowOperationsApiDependencies) {
  return authorized(request, dependencies, async (session, correlationId, repository) => {
    const safeMappingId = serviceNowMappingIdSchema.parse(mappingId);
    const bytes = await readLimitedBodyBytes(request, 1);
    if (bytes.byteLength > 0) throw new HttpError(400, "UNEXPECTED_REQUEST_BODY", "This operation does not accept a request body");
    const result = await (dependencies.deactivate || deactivateServiceNowCustomerMapping)({ mappingId: safeMappingId, session, requestId: correlationId, correlationId }, { repository });
    return jsonResponseWithRequestId(result, request, {}, correlationId);
  });
}

export function handleServiceNowCustomerTargetsGet(request: Request, dependencies: ServiceNowOperationsApiDependencies) {
  return authorized(request, dependencies, async (_session, correlationId, repository) => {
    const query = serviceNowCustomerTargetsQuerySchema.parse(queryObject(request));
    const items = await repository.listCustomerTargets(query.search, query.limit);
    return jsonResponseWithRequestId({ items }, request, {}, correlationId);
  });
}
