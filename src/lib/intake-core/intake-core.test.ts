import { describe, expect, it, vi } from "vitest";
import { createAggregate } from "@/lib/email-intake/test-fixtures";
import { mapEmailIntakeToUnifiedCommand } from "./email-compatibility";
import { hashExternalIdentity, maskExternalIdentity } from "./identity";
import { assertConversationTransition, statusAfterOrdinaryMessage, transitionConversation } from "./conversation";
import { allowedSessionTransitions, assertSessionTransition } from "./session";
import {
  acceptInboundEventSchema, attachmentInputSchema, canonicalTimestampSchema,
  enqueueOutboxInputSchema, intakeIdentifierSchema, sessionTransitionInputSchema,
} from "./schemas";

const timestamp = "2026-07-22T00:00:00.000Z";
const hash = "a".repeat(64);
const correlationId = "request-intake-core-1234";

function eventInput() {
  const subject = "external-user-1";
  return {
    channel: { id: "channel-1", provider: "internal", channelKey: "diagnostic" },
    event: { id: "event-1", externalEventId: "external-event-1", eventType: "message.received", payloadHash: hash, correlationId, receivedAt: timestamp, metadata: {} },
    identity: { id: "identity-1", externalSubjectId: subject, externalSubjectHash: hashExternalIdentity(subject), displayName: "User", identityType: "user", metadata: {} },
    conversation: { id: "conversation-1", externalConversationId: "thread-1", subject: "Subject", openedAt: timestamp, lastActivityAt: timestamp, metadata: {} },
    message: { id: "message-1", externalMessageId: "message-1", direction: "inbound", messageType: "html", status: "stored", bodyText: "Safe preview", bodyHtml: "<script>opaque()</script>", structuredContent: {}, contentHash: hash, receivedAt: timestamp, storedAt: timestamp, metadata: {} },
    attachments: [],
  };
}

describe("unified intake domain validation", () => {
  it("validates and deeply copies normalized input while keeping HTML opaque", () => {
    const source = eventInput();
    const parsed = acceptInboundEventSchema.parse(source);
    expect(parsed.message.bodyHtml).toBe("<script>opaque()</script>");
    source.message.bodyHtml = "changed";
    expect(parsed.message.bodyHtml).toBe("<script>opaque()</script>");
  });

  it("bounds identifiers, rejects controls and malformed Unicode, and normalizes no timestamp silently", () => {
    expect(() => intakeIdentifierSchema("id").parse("bad\r\nid")).toThrow();
    expect(() => intakeIdentifierSchema("id").parse("x".repeat(201))).toThrow();
    expect(() => intakeIdentifierSchema("id").parse("bad\ud800")).toThrow();
    expect(canonicalTimestampSchema.parse(timestamp)).toBe(timestamp);
    expect(() => canonicalTimestampSchema.parse("2026-07-22T00:00:00+00:00")).toThrow();
  });

  it("rejects prototype keys and unsafe attachment material", () => {
    const polluted = eventInput();
    polluted.event.metadata = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(() => acceptInboundEventSchema.parse(polluted)).toThrow(/forbidden/i);
    expect(() => attachmentInputSchema.parse({ id: "attachment-1", fileName: "../secret.txt", contentType: "text/plain", declaredSize: 1 })).toThrow();
    expect(() => attachmentInputSchema.parse({ id: "attachment-1", fileName: "safe.txt", contentType: "text/plain", declaredSize: 1, metadata: { body: "data:text/plain;base64,c2VjcmV0" } })).toThrow(/Base64/i);
    expect(() => attachmentInputSchema.parse({ id: "attachment-1", fileName: "safe.txt", contentType: "text/plain", declaredSize: 300 * 1024 * 1024 })).toThrow();
    expect(() => attachmentInputSchema.parse({ id: "attachment-1", fileName: "safe.txt", contentType: "not-a-mime", declaredSize: 1 })).toThrow();
    expect(() => attachmentInputSchema.parse({ id: "attachment-1", fileName: "safe.txt", contentType: "text/plain", declaredSize: -1 })).toThrow();
    expect(() => attachmentInputSchema.parse({ id: "attachment-1", fileName: "safe.txt", contentType: "text/plain", declaredSize: 1, sha256: "invalid" })).toThrow();
    expect(() => attachmentInputSchema.parse({ id: "attachment-1", fileName: "safe.txt", contentType: "text/plain", declaredSize: 1, providerLocator: "https://storage.example/signed" })).toThrow(/opaque/);
    const secretMetadata = eventInput();
    secretMetadata.event.metadata = { token: "must-not-persist" };
    expect(() => acceptInboundEventSchema.parse(secretMetadata)).toThrow(/Credentials/);
  });

  it("rejects credentials from outbox payloads", () => {
    expect(() => enqueueOutboxInputSchema.parse({ id: "outbox-1", targetProvider: "internal", commandType: "notification.send", idempotencyKey: "key-1", payload: { authorization: "secret" }, availableAt: timestamp, maxAttempts: 5, correlationId, metadata: {} })).toThrow(/Credentials/);
  });

  it("masks external identities without exposing the complete value", () => {
    const full = "Uabcdef0123456789xyz";
    const masked = maskExternalIdentity(full);
    expect(masked).toMatch(/^Uabc/);
    expect(masked).toMatch(/9xyz$/);
    expect(masked).not.toContain(full);
  });
});

describe("intake state machines", () => {
  it("requires explicit closed-conversation reopen and keeps archived conversations closed to messages", () => {
    expect(() => assertConversationTransition("closed", "open")).toThrow();
    expect(() => assertConversationTransition("closed", "open", true)).not.toThrow();
    expect(statusAfterOrdinaryMessage("archived", "inbound")).toBe("archived");
    expect(statusAfterOrdinaryMessage("open", "inbound")).toBe("awaiting_agent");
    expect(() => transitionConversation({ status: "open", version: 2, expectedVersion: 1, targetStatus: "closed", actorUserId: "admin", correlationId, occurredAt: timestamp })).toThrow(/version conflict/i);
    const transitioned = transitionConversation({ status: "open", version: 2, expectedVersion: 2, targetStatus: "closed", actorUserId: "admin", correlationId, occurredAt: timestamp });
    expect(transitioned).toMatchObject({ status: "closed", version: 3, history: { fromStatus: "open", toStatus: "closed", fromVersion: 2, toVersion: 3 } });
    expect(Object.isFrozen(transitioned.history)).toBe(true);
  });

  it("accepts only documented session transitions and treats confirmation as domain state only", () => {
    expect(allowedSessionTransitions.awaiting_confirmation).toContain("confirmed");
    expect(() => assertSessionTransition("awaiting_confirmation", "confirmed")).not.toThrow();
    expect(() => assertSessionTransition("confirmed", "collecting")).toThrow();
    expect(() => sessionTransitionInputSchema.parse({ sessionId: "session-1", expectedVersion: 1, targetStatus: "confirmed", statePatch: { providerPayload: "no" }, missingFields: [], actorUserId: "admin", correlationId, occurredAt: timestamp })).toThrow();
  });
});

describe("Email Intake compatibility bridge", () => {
  it("is pure and creates only a validated normalized command", () => {
    const record = createAggregate().toRecord();
    const original = structuredClone(record);
    const persist = vi.fn(); const enqueue = vi.fn();
    const command = mapEmailIntakeToUnifiedCommand(record, { id: "email-channel-1", channelKey: "support-mailbox" });
    expect(command.channel.provider).toBe("email");
    expect(command.message.bodyText).toBe(record.normalizedText);
    expect(command.attachments).toHaveLength(1);
    expect(record).toEqual(original);
    expect(persist).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
  });
});
