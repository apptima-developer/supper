import type { Session } from "@/lib/auth";
import { can } from "@/lib/rbac";
import { HttpError, jsonResponseWithRequestId, requestId, safeErrorResponse } from "@/lib/request-security";
import { IntakeCoreService } from "./service";
import type { IntakeCoreRepository } from "./repository";
import { intakeIdentifierSchema, listQuerySchema } from "./schemas";
import { serializeIntakeError } from "./errors";

export type IntakeApiDependencies = {
  getSession: () => Promise<Session | null>;
  repository?: IntakeCoreRepository;
  service?: IntakeCoreService;
};

function queryObject(request: Request) {
  return Object.fromEntries(new URL(request.url).searchParams.entries());
}

function denied(session: Session | null, request: Request, correlationId: string) {
  if (!session) return jsonResponseWithRequestId({ error: "Unauthorized", code: "UNAUTHORIZED" }, request, { status: 401, headers: { "Cache-Control": "no-store" } }, correlationId);
  if (!can(session.role, "settings:manage")) return jsonResponseWithRequestId({ error: "Forbidden", code: "FORBIDDEN" }, request, { status: 403, headers: { "Cache-Control": "no-store" } }, correlationId);
  return null;
}

async function authorized(request: Request, dependencies: IntakeApiDependencies, handler: (context: { session: Session; correlationId: string; repository: IntakeCoreRepository; service: IntakeCoreService }) => Promise<unknown>) {
  const correlationId = requestId(request);
  try {
    const session = await dependencies.getSession();
    const rejection = denied(session, request, correlationId);
    if (rejection) return rejection;
    if (!session) throw new HttpError(401, "UNAUTHORIZED", "Unauthorized");
    const repository = dependencies.repository || (await import("./relational-repository")).createRelationalIntakeCoreRepository();
    const service = dependencies.service || new IntakeCoreService(repository);
    const body = await handler({ session, correlationId, repository, service });
    return jsonResponseWithRequestId(body as Record<string, unknown>, request, { headers: { "Cache-Control": "no-store" } }, correlationId);
  } catch (error) {
    const safe = serializeIntakeError(error);
    if (safe.code !== "INTAKE_STORAGE_ERROR") {
      const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 400;
      return jsonResponseWithRequestId(safe, request, { status, headers: { "Cache-Control": "no-store" } }, correlationId);
    }
    return safeErrorResponse(error, "Unified intake request failed", request, 500, correlationId);
  }
}

export function handleIntakeOperationsGet(request: Request, dependencies: IntakeApiDependencies) {
  return authorized(request, dependencies, ({ service }) => service.operations());
}

export function handleIntakeChannelsGet(request: Request, dependencies: IntakeApiDependencies) {
  return authorized(request, dependencies, ({ service }) => service.channels(listQuerySchema.parse(queryObject(request))));
}

export function handleIntakeIdentitiesGet(request: Request, dependencies: IntakeApiDependencies) {
  return authorized(request, dependencies, ({ service }) => service.identities(listQuerySchema.parse(queryObject(request))));
}

export function handleIntakeConversationsGet(request: Request, dependencies: IntakeApiDependencies) {
  return authorized(request, dependencies, ({ service }) => service.conversations(listQuerySchema.parse(queryObject(request))));
}

export function handleIntakeConversationDetailGet(request: Request, conversationId: string, dependencies: IntakeApiDependencies) {
  return authorized(request, dependencies, async ({ service }) => {
    const id = intakeIdentifierSchema("conversationId").parse(conversationId);
    const [conversation, messages, attachments] = await Promise.all([
      service.conversation(id), service.messages(id), service.attachments(id),
    ]);
    if (!conversation) throw new HttpError(404, "INTAKE_CONVERSATION_NOT_FOUND", "Conversation was not found");
    return { conversation, messages, attachments };
  });
}

export function handleIntakeEventsGet(request: Request, dependencies: IntakeApiDependencies) {
  return authorized(request, dependencies, ({ service }) => service.events(listQuerySchema.parse(queryObject(request))));
}

export function handleIntakeOutboxGet(request: Request, dependencies: IntakeApiDependencies) {
  return authorized(request, dependencies, ({ service }) => service.outbox(listQuerySchema.parse(queryObject(request))));
}
