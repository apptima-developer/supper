import type { Session } from "@/lib/auth";
import type { DataBackend } from "@/lib/env";
import { can } from "@/lib/rbac";
import { jsonResponseWithRequestId, requestId, safeErrorResponse } from "@/lib/request-security";
import type { IntakeCoreRepository } from "./repository";
import { IntakeCoreService } from "./service";

type Environment = Record<string, string | undefined>;

export type IntakeDiagnosticDependencies = {
  getSession: () => Promise<Session | null>;
  getBackend: () => DataBackend;
  repository: IntakeCoreRepository;
  service?: IntakeCoreService;
  env?: Environment;
};

export function intakeDiagnosticAllowed(env: Environment = process.env, backend?: DataBackend) {
  const appEnvironment = (env.APP_ENV || "").trim().toLowerCase().replaceAll("_", "-");
  return appEnvironment === "ai-development" && (env.VERCEL_ENV || "").trim().toLowerCase() !== "production" && backend === "supabase-relational";
}

export async function handleIntakeDiagnosticPost(request: Request, dependencies: IntakeDiagnosticDependencies) {
  const correlationId = requestId(request);
  const notFound = () => jsonResponseWithRequestId({ error: "Not found", code: "NOT_FOUND" }, request, { status: 404, headers: { "Cache-Control": "no-store" } }, correlationId);
  try {
    const backend = dependencies.getBackend();
    if (!intakeDiagnosticAllowed(dependencies.env || process.env, backend)) return notFound();
    const session = await dependencies.getSession();
    if (!session || !can(session.role, "settings:manage")) return notFound();

    const repository = dependencies.repository;
    const service = dependencies.service || new IntakeCoreService(repository);
    const timestamp = "2026-07-22T00:00:00.000Z";
    const externalSubject = "supper-internal-diagnostic-identity-v2";
    const bodyText = "Unified intake diagnostic message. No external provider was contacted.";
    const input = {
      channel: { id: "intake-diagnostic-channel-v2", provider: "internal" as const, channelKey: "unified-intake-diagnostic-v2" },
      event: { id: "intake-diagnostic-event-v2", externalEventId: "supper-diagnostic:event:v2", eventType: "message.received" as const, correlationId, requestId: correlationId, receivedAt: timestamp, metadata: { diagnostic: true } },
      identity: { id: "intake-diagnostic-identity-v2", externalSubjectId: externalSubject, displayName: "Diagnostic identity", identityType: "system" as const, metadata: { diagnostic: true } },
      conversation: { id: "intake-diagnostic-conversation-v2", externalConversationId: "supper-diagnostic:conversation:v2", subject: "Unified Intake diagnostic", openedAt: timestamp, lastActivityAt: timestamp, metadata: { diagnostic: true } },
      message: { id: "intake-diagnostic-message-v2", externalMessageId: "supper-diagnostic:message:v2", direction: "internal" as const, messageType: "text" as const, status: "stored" as const, bodyText, bodyHtml: "", structuredContent: {}, receivedAt: timestamp, storedAt: timestamp, metadata: { diagnostic: true } },
      attachments: [{ id: "intake-diagnostic-attachment-v2", externalAttachmentId: "supper-diagnostic:attachment:v2", fileName: "diagnostic-metadata.txt", contentType: "text/plain", declaredSize: 128, storageStatus: "declared" as const, scanStatus: "not_scanned" as const, metadata: { diagnostic: true } }],
      initializeSession: { id: "intake-diagnostic-session-v2", status: "collecting" as const, stateData: { requestType: "diagnostic" }, missingFields: ["selectedCustomerKey", "description"], startedAt: timestamp, metadata: { diagnostic: true } },
    };
    await repository.ensureDiagnosticChannel({ id: input.channel.id, channelKey: input.channel.channelKey, displayName: "Unified Intake Diagnostic", now: timestamp, actorUserId: session.userId });
    const first = await service.accept(input);
    const replay = await service.accept(input);
    const [messages, attachments, intakeSession] = await Promise.all([
      repository.listConversationMessages(first.conversation_id, { page: 1, limit: 100 }),
      repository.listConversationAttachments(first.conversation_id, { page: 1, limit: 100 }),
      first.session_id ? repository.findSession(first.session_id) : Promise.resolve(undefined),
    ]);
    return jsonResponseWithRequestId({
      firstAction: first.action, replayAction: replay.action, duplicateReplayProtected: replay.action === "duplicate",
      eventId: first.event_id, conversationId: first.conversation_id, messageId: first.message_id,
      messageCount: messages.total, attachmentMetadataCount: attachments.total,
      sessionId: first.session_id, sessionStatus: intakeSession?.status || null, deliveryCount: replay.delivery_count,
    }, request, { headers: { "Cache-Control": "no-store" } }, correlationId);
  } catch (error) {
    return safeErrorResponse(error, "Unified intake diagnostic failed", request, 500, correlationId);
  }
}
