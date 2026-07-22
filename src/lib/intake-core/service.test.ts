import { describe, expect, it, vi } from "vitest";
import type { IntakeCoreRepository } from "./repository";
import { IntakeCoreService } from "./service";

const timestamp = "2026-07-22T00:00:00.000Z";
const correlationId = "request-intake-service-1234";

function normalizedEvent() {
  const externalSubjectId = "service-test-subject";
  return {
    channel: { id: "channel-1", provider: "internal", channelKey: "test" },
    event: { id: "event-1", externalEventId: "external-event-1", eventType: "message.received", correlationId, receivedAt: timestamp, metadata: {} },
    identity: { id: "identity-1", externalSubjectId, displayName: "Test", identityType: "system", metadata: {} },
    conversation: { id: "conversation-1", externalConversationId: "external-conversation-1", subject: "Test", openedAt: timestamp, lastActivityAt: timestamp, metadata: {} },
    message: { id: "message-1", externalMessageId: "external-message-1", direction: "internal", messageType: "text", status: "stored", bodyText: "Test", bodyHtml: "", structuredContent: {}, receivedAt: timestamp, storedAt: timestamp, metadata: {} },
    attachments: [],
  };
}

function repository() {
  return {
    acceptInboundEvent: vi.fn(async () => ({ action: "accepted", event_id: "event-1", identity_id: "identity-1", conversation_id: "conversation-1", message_id: "message-1", attachment_count: 0, session_id: null, delivery_count: 1 })),
    enqueueOutbox: vi.fn(),
    linkConversationTicket: vi.fn(),
    transitionSession: vi.fn(async () => ({ status: "confirmed" })),
  } as unknown as IntakeCoreRepository;
}

describe("Unified Intake application service boundaries", () => {
  it("rejects writes before repository access on non-relational backends", async () => {
    const store = repository();
    const service = new IntakeCoreService(store, () => "local-json");
    expect(() => service.accept(normalizedEvent())).toThrow(expect.objectContaining({ code: "INTAKE_RELATIONAL_BACKEND_REQUIRED", status: 503 }));
    expect(store.acceptInboundEvent).not.toHaveBeenCalled();
  });

  it("accepts normalized intake without creating a Ticket link or outbox command", async () => {
    const store = repository();
    const service = new IntakeCoreService(store, () => "supabase-relational");
    await expect(service.accept(normalizedEvent())).resolves.toMatchObject({ action: "accepted" });
    expect(store.acceptInboundEvent).toHaveBeenCalledTimes(1);
    expect(store.linkConversationTicket).not.toHaveBeenCalled();
    expect(store.enqueueOutbox).not.toHaveBeenCalled();
  });
});
