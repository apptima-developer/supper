import type { Session } from "../../../auth";
import { can } from "../../../rbac";
import {
  HttpError,
  jsonResponseWithRequestId,
  readJsonBody,
  readLimitedBodyBytes,
  requestId,
  safeErrorResponse,
} from "../../../request-security";
import { isIntegrationBoundaryError } from "../../errors";
import { serviceNowErrorHttpStatus } from "../errors";
import { ServiceNowWriteRepository } from "./repository";
import {
  confirmedServiceNowWriteActionRequestSchema,
  createServiceNowWriteCommandRequestSchema,
  issueServiceNowManualOperationRequestSchema,
  issueServiceNowWriteConfirmationRequestSchema,
  queryObject,
  reconcileServiceNowWriteCommandRequestSchema,
  serviceNowWriteCommandIdSchema,
  serviceNowWriteCommandsQuerySchema,
} from "./schemas";
import {
  createCommand,
  executeCommand,
  executeCommandDryRun,
  getCommandStatus,
  getServiceNowWriteOperationsSummary,
  issueCommandConfirmation,
  issueManualOperation,
  listCommands,
  reconcileCommand,
  retryCommand,
  testServiceNowWriteReadiness,
} from "./service";

export type ServiceNowWriteApiDependencies = {
  getSession: () => Promise<Session | null>;
  repository?: ServiceNowWriteRepository;
  create?: typeof createCommand;
  issueManualOperation?: typeof issueManualOperation;
  dryRun?: typeof executeCommandDryRun;
  execute?: typeof executeCommand;
  retry?: typeof retryCommand;
  detail?: typeof getCommandStatus;
  list?: typeof listCommands;
  summary?: typeof getServiceNowWriteOperationsSummary;
  readiness?: typeof testServiceNowWriteReadiness;
  issueConfirmation?: typeof issueCommandConfirmation;
  reconcile?: typeof reconcileCommand;
};

function authorize(session: Session | null, request: Request, correlationId: string) {
  if (!session) return jsonResponseWithRequestId({ error: "Unauthorized", code: "UNAUTHORIZED" }, request, { status: 401 }, correlationId);
  if (!can(session.role, "settings:manage")) return jsonResponseWithRequestId({ error: "Forbidden", code: "FORBIDDEN" }, request, { status: 403 }, correlationId);
  return null;
}

function writeErrorResponse(error: unknown, request: Request, correlationId: string) {
  if (!isIntegrationBoundaryError(error)) {
    return safeErrorResponse(error, "ServiceNow write request failed", request, 500, correlationId);
  }
  return jsonResponseWithRequestId({
    error: error.safeMessage,
    code: error.code,
    category: error.category,
    retryable: error.retryable,
  }, request, { status: serviceNowErrorHttpStatus(error) }, correlationId);
}

async function authorized(
  request: Request,
  dependencies: ServiceNowWriteApiDependencies,
  handler: (session: Session, correlationId: string, repository: ServiceNowWriteRepository) => Promise<Response>,
) {
  const correlationId = requestId(request);
  try {
    const session = await dependencies.getSession();
    const denied = authorize(session, request, correlationId);
    if (denied) return denied;
    if (!session) throw new HttpError(401, "UNAUTHORIZED", "Unauthorized");
    return await handler(session, correlationId, dependencies.repository || new ServiceNowWriteRepository());
  } catch (error) {
    return writeErrorResponse(error, request, correlationId);
  }
}

export function handleServiceNowWriteOperationsGet(request: Request, dependencies: ServiceNowWriteApiDependencies) {
  return authorized(request, dependencies, async (_session, correlationId, repository) => {
    const result = await (dependencies.summary || getServiceNowWriteOperationsSummary)({ repository });
    return jsonResponseWithRequestId(result, request, {}, correlationId);
  });
}

export function handleServiceNowWriteCommandsGet(request: Request, dependencies: ServiceNowWriteApiDependencies) {
  return authorized(request, dependencies, async (_session, correlationId, repository) => {
    const filters = serviceNowWriteCommandsQuerySchema.parse(queryObject(request));
    const result = await (dependencies.list || listCommands)(filters, { repository });
    return jsonResponseWithRequestId(result, request, {}, correlationId);
  });
}

export function handleServiceNowWriteCommandsPost(request: Request, dependencies: ServiceNowWriteApiDependencies) {
  return authorized(request, dependencies, async (session, correlationId, repository) => {
    const body = await readJsonBody(request, createServiceNowWriteCommandRequestSchema, 64 * 1024);
    const result = await (dependencies.create || createCommand)({
      ...body,
      session,
      requestId: correlationId,
      correlationId,
    }, { repository });
    return jsonResponseWithRequestId(result, request, { status: 201 }, correlationId);
  });
}

export function handleServiceNowWriteManualOperationPost(
  request: Request,
  dependencies: ServiceNowWriteApiDependencies,
) {
  return authorized(request, dependencies, async (session, correlationId) => {
    const body = await readJsonBody(request, issueServiceNowManualOperationRequestSchema, 4 * 1024);
    const result = await (dependencies.issueManualOperation || issueManualOperation)({
      ...body,
      session,
    });
    return jsonResponseWithRequestId(result, request, { status: 201 }, correlationId);
  });
}

export function handleServiceNowWriteCommandDetailGet(
  request: Request,
  commandId: string,
  dependencies: ServiceNowWriteApiDependencies,
) {
  return authorized(request, dependencies, async (_session, correlationId, repository) => {
    const result = await (dependencies.detail || getCommandStatus)(
      serviceNowWriteCommandIdSchema.parse(commandId),
      { repository },
    );
    return jsonResponseWithRequestId(result, request, {}, correlationId);
  });
}

async function commandAction(
  request: Request,
  commandId: string,
  dependencies: ServiceNowWriteApiDependencies,
  action: "dry_run" | "execute" | "retry",
) {
  return authorized(request, dependencies, async (session, correlationId, repository) => {
    const safeCommandId = serviceNowWriteCommandIdSchema.parse(commandId);
    const confirmation = action === "dry_run"
      ? undefined
      : await readJsonBody(request, confirmedServiceNowWriteActionRequestSchema, 4 * 1024);
    if (action === "dry_run") {
      const bytes = await readLimitedBodyBytes(request, 1);
      if (bytes.byteLength) throw new HttpError(400, "UNEXPECTED_REQUEST_BODY", "This operation does not accept a request body");
    }
    const common = {
      commandId: safeCommandId,
      session,
      requestId: correlationId,
      correlationId,
      abortSignal: request.signal,
    };
    const result = action === "dry_run"
      ? await (dependencies.dryRun || executeCommandDryRun)(common, { repository })
      : action === "execute"
        ? await (dependencies.execute || executeCommand)({ ...common, confirmation: confirmation! }, { repository })
        : await (dependencies.retry || retryCommand)({ ...common, confirmation: confirmation! }, { repository });
    return jsonResponseWithRequestId(result, request, {}, correlationId);
  });
}

export function handleServiceNowWriteConfirmationPost(
  request: Request,
  commandId: string,
  dependencies: ServiceNowWriteApiDependencies,
) {
  return authorized(request, dependencies, async (session, correlationId, repository) => {
    const body = await readJsonBody(request, issueServiceNowWriteConfirmationRequestSchema, 4 * 1024);
    const result = await (dependencies.issueConfirmation || issueCommandConfirmation)({
      commandId: serviceNowWriteCommandIdSchema.parse(commandId),
      ...body,
      session,
    }, { repository });
    return jsonResponseWithRequestId(result, request, { status: 201 }, correlationId);
  });
}

export function handleServiceNowWriteReconciliationPost(
  request: Request,
  commandId: string,
  dependencies: ServiceNowWriteApiDependencies,
) {
  return authorized(request, dependencies, async (session, correlationId, repository) => {
    const body = await readJsonBody(request, reconcileServiceNowWriteCommandRequestSchema, 4 * 1024);
    const result = await (dependencies.reconcile || reconcileCommand)({
      commandId: serviceNowWriteCommandIdSchema.parse(commandId),
      action: body.action,
      session,
      requestId: correlationId,
      correlationId,
      confirmation: body,
      verifiedTargetSysId: "verifiedTargetSysId" in body ? body.verifiedTargetSysId : undefined,
      verifiedTargetNumber: "verifiedTargetNumber" in body ? body.verifiedTargetNumber : undefined,
      verificationAcknowledged: "verificationAcknowledged" in body ? body.verificationAcknowledged : undefined,
      duplicateJournalRiskAcknowledged: "duplicateJournalRiskAcknowledged" in body
        ? body.duplicateJournalRiskAcknowledged
        : undefined,
      mutationCandidateRiskAcknowledged: "mutationCandidateRiskAcknowledged" in body
        ? body.mutationCandidateRiskAcknowledged
        : undefined,
      verificationNote: "verificationNote" in body ? body.verificationNote : undefined,
      abortSignal: request.signal,
    }, { repository });
    return jsonResponseWithRequestId(result, request, {}, correlationId);
  });
}

export function handleServiceNowWriteCommandDryRunPost(
  request: Request,
  commandId: string,
  dependencies: ServiceNowWriteApiDependencies,
) {
  return commandAction(request, commandId, dependencies, "dry_run");
}

export function handleServiceNowWriteCommandExecutePost(
  request: Request,
  commandId: string,
  dependencies: ServiceNowWriteApiDependencies,
) {
  return commandAction(request, commandId, dependencies, "execute");
}

export function handleServiceNowWriteCommandRetryPost(
  request: Request,
  commandId: string,
  dependencies: ServiceNowWriteApiDependencies,
) {
  return commandAction(request, commandId, dependencies, "retry");
}

export function handleServiceNowWriteReadinessPost(request: Request, dependencies: ServiceNowWriteApiDependencies) {
  return authorized(request, dependencies, async (session, correlationId) => {
    const bytes = await readLimitedBodyBytes(request, 1);
    if (bytes.byteLength) throw new HttpError(400, "UNEXPECTED_REQUEST_BODY", "This operation does not accept a request body");
    const result = await (dependencies.readiness || testServiceNowWriteReadiness)({
      correlationId,
      session,
      abortSignal: request.signal,
    });
    return jsonResponseWithRequestId(result, request, {}, correlationId);
  });
}
