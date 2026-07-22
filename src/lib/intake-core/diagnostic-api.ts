import { createHash } from "node:crypto";
import type { Session } from "@/lib/auth";
import type { DataBackend } from "@/lib/env";
import { can } from "@/lib/rbac";
import { jsonResponseWithRequestId, requestId, safeErrorResponse } from "@/lib/request-security";
import { hashExternalIdentity } from "./identity";
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

function digest(value: unknown) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
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
    const externalSubject = "supper-internal-diagnostic-identity-v1";
    const bodyText = "Unified intake diagnostic message. No external provider was contacted.";
    const input = {
      channel: { id: "intake-diagnostic-channel-v1", provider: "internal" as const, channelKey: "unified-intake-diagnostic" },
      event: { id: "intake-diagnostic-event-v1", externalEventId: "supper-diagnostic:event:v1", eventType: "message.received" as const, payloadHash: digest("supper-diagnostic-payload-v1"), correlationId, requestId: correlationId, receivedAt: timestamp, metadata: { diagnostic: true } },
      identity: { id: "intake-diagnostic-identity-v1", externalSubjectId: externalSubject, externalSubjectHash: hashExternalIdentity(externalSubject), displayName: "Diagnostic identity", identityType: "system" as const, metadata: { diagnostic: true } },
      conversation: { id: "intake-diagnostic-conversation-v1", externalConversationId: "supper-diagnostic:conversation:v1", subject: "Unified Intake diagnostic", openedAt: timestamp, lastActivityAt: timestamp, metadata: { diagnostic: true } },
      message: { id: "intake-diagnostic-message-v1", externalMessageId: "supper-diagnostic:message:v1", direction: "internal" as const, messageType: "text" as const, status: "stored" as const, bodyText, bodyHtml: "", structuredContent: {}, contentHash: digest(bodyText), receivedAt: timestamp, storedAt: timestamp, metadata: { diagnostic: true } },
      attachments: [{ id: "intake-diagnostic-attachment-v1", externalAttachmentId: "supper-diagnostic:attachment:v1", fileName: "diagnostic-metadata.txt", contentType: "text/plain", declaredSize: 128, storageStatus: "declared" as const, scanStatus: "not_scanned" as const, metadata: { diagnostic: true } }],
      initializeSession: { id: "intake-diagnostic-session-v1", status: "collecting" as const, stateData: { requestType: "diagnostic" }, missingFields: ["selectedCustomerKey", "description"], startedAt: timestamp },
    };
    await repository.ensureDiagnosticChannel({ id: input.channel.id, channelKey: input.channel.channelKey, displayName: "Unified Intake Diagnostic", now: timestamp, actorUserId: session.userId });
    const first = await service.accept(input);
    const replay = await service.accept(input);
    const [messages, attachments, intakeSession] = await Promise.all([
      repository.listConversationMessages(first.conversation_id),
      repository.listConversationAttachments(first.conversation_id),
      first.session_id ? repository.findSession(first.session_id) : Promise.resolve(undefined),
    ]);
    return jsonResponseWithRequestId({
      firstAction: first.action, replayAction: replay.action, duplicateReplayProtected: replay.action === "duplicate",
      eventId: first.event_id, conversationId: first.conversation_id, messageId: first.message_id,
      messageCount: messages.length, attachmentMetadataCount: attachments.length,
      sessionId: first.session_id, sessionStatus: intakeSession?.status || null, deliveryCount: replay.delivery_count,
    }, request, { headers: { "Cache-Control": "no-store" } }, correlationId);
  } catch (error) {
    return safeErrorResponse(error, "Unified intake diagnostic failed", request, 500, correlationId);
  }
}
