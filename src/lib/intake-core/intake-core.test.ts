import { describe, expect, it, vi } from "vitest";
import { createAggregate } from "@/lib/email-intake/test-fixtures";
import {
  canonicalIntakeAttachmentSourceHash, canonicalIntakeEventMaterial, canonicalIntakeMessageMaterial, canonicalSerializeIntakeMaterial,
  hashCanonicalIntakeMaterial, prepareCanonicalIntakeEvent,
} from "./canonical-material";
import canonicalVectors from "./canonical-vectors.json";
import sensitiveKeyVectors from "./sensitive-key-vectors.json";
import { mapEmailIntakeToUnifiedCommand } from "./email-compatibility";
import { maskExternalIdentity } from "./identity";
import { assertConversationTransition, statusAfterOrdinaryMessage, transitionConversation } from "./conversation";
import { allowedSessionTransitions, assertSessionTransition } from "./session";
import { classifyIntakeJsonKey, findUnsafeIntakeJsonKey } from "./sensitive-data";
import { IntakeCoreError, intakeErrorFromUnknown, serializeIntakeError } from "./errors";
import {
  acceptInboundEventInputSchema, attachmentInputSchema, canonicalTimestampSchema,
  enqueueOutboxInputSchema, intakeIdentifierSchema, sessionTransitionInputSchema, targetReferencesSchema,
} from "./schemas";

const timestamp = "2026-07-22T00:00:00.000Z";
const correlationId = "request-intake-core-1234";

function eventInput() {
  return {
    channel: { id: "channel-1", provider: "internal" as const, channelKey: "diagnostic" },
    event: { id: "event-1", externalEventId: "external-event-1", eventType: "message.received" as const, correlationId, receivedAt: timestamp, metadata: {} },
    identity: { id: "identity-1", externalSubjectId: "external-user-1", displayName: "User", identityType: "user" as const, metadata: {} },
    conversation: { id: "conversation-1", externalConversationId: "thread-1", subject: "Subject", openedAt: timestamp, lastActivityAt: timestamp, metadata: {} },
    message: { id: "message-1", externalMessageId: "message-1", direction: "inbound" as const, messageType: "html" as const, status: "stored" as const, bodyText: "Safe preview", bodyHtml: "<script>opaque()</script>", structuredContent: {}, receivedAt: timestamp, storedAt: timestamp, metadata: {} },
    attachments: [{ id: "attachment-1", externalAttachmentId: "external-attachment-1", fileName: "evidence.txt", contentType: "text/plain", declaredSize: 12, metadata: { ordinal: 0 } }],
  };
}

describe("recursive Unified Intake sensitive-data policy", () => {
  it.each(sensitiveKeyVectors.reject)("rejects shared compact credential fixture %s", (key) => {
    expect(classifyIntakeJsonKey(key)).toBe("sensitive");
    expect(findUnsafeIntakeJsonKey({ safe: [{ nested: { [key]: "value" } }] })?.classification).toBe("sensitive");
  });

  it.each(sensitiveKeyVectors.accept)("accepts shared safe-word fixture %s", (key) => {
    expect(classifyIntakeJsonKey(key)).toBe("safe");
  });

  it.each([
    "clientSecret", "Client-Secret", "client_secret", "channelAccessToken", "serviceNowPassword", "authorizationHeader",
    "x-api-key", "oauthClientSecret", "refreshTokenValue", "signedDownloadUrl", "apikey", "xapikey", "clientsecret",
    "channelsecret", "accesstoken", "refreshtoken", "bearertoken", "servicerolekey", "supabaseservicerolekey",
    "webhooksecret", "sessionsecret", "signedurl", "signeddownloadurl", "authenticationcredential",
  ])("rejects compound credential key %s", (key) => {
    expect(classifyIntakeJsonKey(key)).toBe("sensitive");
    expect(findUnsafeIntakeJsonKey({ safe: [{ nested: { [key]: "value" } }] })?.classification).toBe("sensitive");
  });

  it("rejects raw provider payload keys and Unicode/control tricks", () => {
    expect(classifyIntakeJsonKey("rawPayload")).toBe("forbidden-provider-payload");
    expect(classifyIntakeJsonKey("tok\u0435n")).toBe("invalid");
    expect(classifyIntakeJsonKey("safe\nkey")).toBe("invalid");
  });

  it("accepts only ordinary allowlisted metadata", () => {
    const input = eventInput();
    input.event.metadata = { source: "internal-adapter" };
    expect(acceptInboundEventInputSchema.parse(input).event.metadata).toEqual({ source: "internal-adapter" });
    expect(() => acceptInboundEventInputSchema.parse({ ...eventInput(), event: { ...eventInput().event, metadata: { unknown: true } } })).toThrow(/unrecognized/i);
    expect(() => acceptInboundEventInputSchema.parse({ ...eventInput(), message: { ...eventInput().message, structuredContent: { nested: { clientSecret: "no" } } } })).toThrow(/Credentials/i);
  });

  it("applies contextual compact classification recursively across every arbitrary JSON boundary", () => {
    expect(() => acceptInboundEventInputSchema.parse({
      ...eventInput(), message: { ...eventInput().message, structuredContent: { nested: [{ linetoken: "no" }] } },
    })).toThrow(/Credentials/i);
    expect(() => acceptInboundEventInputSchema.parse({
      ...eventInput(), event: { ...eventInput().event, metadata: { appsecret: "no" } },
    })).toThrow(/Credentials/i);
    expect(() => targetReferencesSchema.parse({ internal: { authorizationvalue: "no" } })).toThrow(/INTAKE_SENSITIVE_DATA_REJECTED/);
    expect(() => enqueueOutboxInputSchema.parse({
      id: "outbox-compact-secret", targetProvider: "internal", commandType: "notification.send",
      idempotencyKey: "compact-secret-key", payload: { nested: { signedasseturl: "no" } },
      availableAt: timestamp, correlationId, metadata: {},
    })).toThrow(/Credentials/i);
  });
});

describe("canonical event, message, and attachment material", () => {
  it("matches the committed cross-language canonical vectors", () => {
    for (const vector of canonicalVectors) {
      if (!vector.valid) {
        expect(() => canonicalSerializeIntakeMaterial(vector.input as never), vector.name).toThrow(/INTAKE_CANONICAL_NUMBER_INVALID/);
        continue;
      }
      expect(canonicalSerializeIntakeMaterial(vector.input as never), vector.name).toBe(vector.serialized);
      expect(hashCanonicalIntakeMaterial(vector.input as never), vector.name).toBe(vector.sha256);
    }
  });

  it("keeps immutable Attachment source identity independent from local lifecycle state", () => {
    const source = acceptInboundEventInputSchema.parse(eventInput()).attachments[0];
    const baseline = canonicalIntakeAttachmentSourceHash(source);
    expect(canonicalIntakeAttachmentSourceHash({ ...source, storageStatus: "stored" })).toBe(baseline);
    expect(canonicalIntakeAttachmentSourceHash({ ...source, scanStatus: "clean" })).toBe(baseline);
    expect(canonicalIntakeAttachmentSourceHash({ ...source, retentionUntil: "2027-07-22T00:00:00.000Z" })).toBe(baseline);
    expect(canonicalIntakeAttachmentSourceHash({ ...source, storageObjectKey: "opaque-local-key" } as typeof source & { storageObjectKey: string })).toBe(baseline);
    expect(canonicalIntakeAttachmentSourceHash({ ...source, fileName: "changed.txt" })).not.toBe(baseline);
    expect(canonicalIntakeAttachmentSourceHash({ ...source, declaredSize: source.declaredSize + 1 })).not.toBe(baseline);
    expect(canonicalIntakeAttachmentSourceHash({ ...source, sha256: "a".repeat(64) })).not.toBe(baseline);
    expect(canonicalIntakeAttachmentSourceHash({ ...source, externalAttachmentId: "changed-id" })).not.toBe(baseline);
  });

  it("is deterministic, stable across key order, and preserves meaningful body whitespace", () => {
    const first = prepareCanonicalIntakeEvent(eventInput());
    const reordered = prepareCanonicalIntakeEvent({ ...eventInput(), message: { ...eventInput().message, structuredContent: { beta: 2, alpha: 1 } } });
    const sameReordered = prepareCanonicalIntakeEvent({ ...eventInput(), message: { ...eventInput().message, structuredContent: { alpha: 1, beta: 2 } } });
    expect(reordered.message.contentHash).toBe(sameReordered.message.contentHash);
    expect(canonicalSerializeIntakeMaterial({ beta: 2, alpha: 1 })).toBe(canonicalSerializeIntakeMaterial({ alpha: 1, beta: 2 }));
    expect(first.message.bodyText).toBe("Safe preview");
    const spaced = prepareCanonicalIntakeEvent({ ...eventInput(), message: { ...eventInput().message, bodyText: "Safe  preview" } });
    expect(spaced.message.contentHash).not.toBe(first.message.contentHash);
  });

  it("changes message and event hashes for sender, conversation, and attachment material", () => {
    const baseline = prepareCanonicalIntakeEvent(eventInput());
    const mutations = [
      { ...eventInput(), identity: { ...eventInput().identity, externalSubjectId: "another-sender" } },
      { ...eventInput(), conversation: { ...eventInput().conversation, externalConversationId: "another-thread" } },
      { ...eventInput(), attachments: [{ ...eventInput().attachments[0], declaredSize: 13 }] },
    ];
    for (const mutation of mutations) {
      const changed = prepareCanonicalIntakeEvent(mutation);
      expect(changed.message.contentHash).not.toBe(baseline.message.contentHash);
      expect(changed.event.payloadHash).not.toBe(baseline.event.payloadHash);
    }
  });

  it("keeps transport receipt time out of stable Event replay identity", () => {
    const baseline = prepareCanonicalIntakeEvent(eventInput());
    const redelivery = prepareCanonicalIntakeEvent({
      ...eventInput(),
      event: { ...eventInput().event, receivedAt: "2026-07-22T00:05:00.000Z" },
    });
    expect(redelivery.event.payloadHash).toBe(baseline.event.payloadHash);
  });

  it("rejects caller-calculated hashes that differ from server material", () => {
    expect(() => prepareCanonicalIntakeEvent({ ...eventInput(), event: { ...eventInput().event, payloadHash: "a".repeat(64) } })).toThrow(/hash/i);
    const parsed = acceptInboundEventInputSchema.parse(eventInput());
    expect(hashCanonicalIntakeMaterial(canonicalIntakeMessageMaterial(parsed))).toHaveLength(64);
    expect(hashCanonicalIntakeMaterial(canonicalIntakeEventMaterial(parsed))).toHaveLength(64);
  });
});

describe("unified intake domain validation", () => {
  it("rejects duplicate attachment identifiers before canonical hashing", () => {
    const base = eventInput();
    const duplicateInternal = {
      ...base,
      attachments: [base.attachments[0], { ...base.attachments[0], externalAttachmentId: "external-attachment-2" }],
    };
    expect(() => acceptInboundEventInputSchema.parse(duplicateInternal)).toThrow(/INTAKE_ATTACHMENT_DUPLICATE_IN_EVENT/);

    const duplicateExternal = {
      ...base,
      attachments: [base.attachments[0], { ...base.attachments[0], id: "attachment-2" }],
    };
    expect(() => acceptInboundEventInputSchema.parse(duplicateExternal)).toThrow(/INTAKE_ATTACHMENT_DUPLICATE_IN_EVENT/);

    const sameMaterialDistinctExternalIds = {
      ...base,
      attachments: [base.attachments[0], {
        ...base.attachments[0], id: "attachment-2", externalAttachmentId: "external-attachment-2",
      }],
    };
    expect(acceptInboundEventInputSchema.parse(sameMaterialDistinctExternalIds).attachments).toHaveLength(2);
  });

  it("deeply copies normalized input while keeping HTML opaque", () => {
    const source = eventInput();
    const parsed = acceptInboundEventInputSchema.parse(source);
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
    expect(() => acceptInboundEventInputSchema.parse(polluted)).toThrow(/invalid|forbidden/i);
    expect(() => attachmentInputSchema.parse({ id: "attachment-1", fileName: "../secret.txt", contentType: "text/plain", declaredSize: 1 })).toThrow();
    expect(() => attachmentInputSchema.parse({ id: "attachment-1", fileName: "safe.txt", contentType: "text/plain", declaredSize: 1, metadata: { source: "data:text/plain;base64,c2VjcmV0" } })).toThrow(/Base64/i);
    expect(() => attachmentInputSchema.parse({ id: "attachment-1", fileName: "safe.txt", contentType: "text/plain", declaredSize: 300 * 1024 * 1024 })).toThrow();
    expect(() => attachmentInputSchema.parse({ id: "attachment-1", fileName: "safe.txt", contentType: "not-a-mime", declaredSize: 1 })).toThrow();
    expect(() => attachmentInputSchema.parse({ id: "attachment-1", fileName: "safe.txt", contentType: "text/plain", declaredSize: -1 })).toThrow();
    expect(() => attachmentInputSchema.parse({ id: "attachment-1", fileName: "safe.txt", contentType: "text/plain", declaredSize: 1, sha256: "invalid" })).toThrow();
    expect(() => attachmentInputSchema.parse({ id: "attachment-1", fileName: "safe.txt", contentType: "text/plain", declaredSize: 1, providerLocator: "https://storage.example/signed" })).toThrow(/opaque/);
  });

  it("rejects credentials from outbox payloads and accepts every target provider filter", () => {
    expect(() => enqueueOutboxInputSchema.parse({ id: "outbox-1", targetProvider: "internal", commandType: "notification.send", idempotencyKey: "key-1", payload: { nested: { authorizationHeader: "secret" } }, availableAt: timestamp, maxAttempts: 5, correlationId, metadata: {} })).toThrow(/Credentials/);
    for (const provider of ["email", "n8n", "servicenow", "internal", "line", "web", "freshservice"] as const) {
      expect(enqueueOutboxInputSchema.parse({ id: `outbox-${provider}`, targetProvider: provider, commandType: "notification.send", idempotencyKey: `key-${provider}`, payload: { kind: "safe" }, availableAt: timestamp, maxAttempts: 5, correlationId, metadata: {} }).targetProvider).toBe(provider);
    }
  });

  it("uses one strict nested provider-neutral target reference contract", () => {
    expect(targetReferencesSchema.parse({ servicenow: { callerId: "6816f79abc", companyId: "abc123" } })).toEqual({
      servicenow: { callerId: "6816f79abc", companyId: "abc123" },
    });
    expect(targetReferencesSchema.parse({ internal: {} })).toEqual({ internal: {} });
    expect(() => targetReferencesSchema.parse({ unknown: { userId: "one" } })).toThrow();
    expect(() => targetReferencesSchema.parse({ servicenow: { rawPayload: {} } })).toThrow();
    expect(() => targetReferencesSchema.parse({ servicenow: { clientsecret: "no" } })).toThrow(/INTAKE_SENSITIVE_DATA_REJECTED/);
    expect(() => targetReferencesSchema.parse({ servicenow: { callerId: "https://example.test/id" } })).toThrow(/not URLs/);
  });

  it("rejects fractional and unsafe integers throughout arbitrary JSON", () => {
    expect(() => acceptInboundEventInputSchema.parse({ ...eventInput(), message: { ...eventInput().message, structuredContent: { score: 1.5 } } })).toThrow(/INTAKE_CANONICAL_NUMBER_INVALID/);
    expect(() => enqueueOutboxInputSchema.parse({ id: "outbox-number", targetProvider: "internal", commandType: "notification.send", idempotencyKey: "number-key", payload: { unsafe: 9007199254740992 }, availableAt: timestamp, correlationId, metadata: {} })).toThrow(/INTAKE_CANONICAL_NUMBER_INVALID/);
  });

  it("masks external identities without exposing the complete value", () => {
    const full = "Uabcdef0123456789xyz";
    const masked = maskExternalIdentity(full);
    expect(masked).toMatch(/^Uabc/); expect(masked).toMatch(/9xyz$/); expect(masked).not.toContain(full);
  });
});

describe("intake state machines", () => {
  it("requires explicit closed-conversation reopen and keeps archived conversations closed to messages", () => {
    expect(() => assertConversationTransition("closed", "open")).toThrow();
    expect(() => assertConversationTransition("closed", "open", true)).not.toThrow();
    expect(() => assertConversationTransition("archived", "open", true)).toThrow();
    expect(statusAfterOrdinaryMessage("archived", "inbound")).toBe("archived");
    expect(statusAfterOrdinaryMessage("closed", "inbound")).toBe("closed");
    expect(statusAfterOrdinaryMessage("open", "inbound")).toBe("awaiting_agent");
    expect(() => transitionConversation({ status: "open", version: 2, expectedVersion: 1, targetStatus: "closed", actorUserId: "admin", correlationId, occurredAt: timestamp })).toThrow(/version conflict/i);
    const transitioned = transitionConversation({ status: "open", version: 2, expectedVersion: 2, targetStatus: "closed", actorUserId: "admin", correlationId, occurredAt: timestamp });
    expect(transitioned).toMatchObject({ action: "changed", status: "closed", version: 3, history: { fromStatus: "open", toStatus: "closed", fromVersion: 2, toVersion: 3 } });
    expect(transitioned.history && Object.isFrozen(transitioned.history)).toBe(true);
    const unchanged = transitionConversation({ status: "open", version: 2, expectedVersion: 2, targetStatus: "open", actorUserId: "admin", correlationId, occurredAt: timestamp });
    expect(unchanged).toEqual({ action: "unchanged", status: "open", version: 2, history: null });
  });

  it("accepts only documented session transitions and treats confirmation as domain state only", () => {
    expect(allowedSessionTransitions.awaiting_confirmation).toContain("confirmed");
    expect(() => assertSessionTransition("awaiting_confirmation", "confirmed")).not.toThrow();
    expect(() => assertSessionTransition("confirmed", "collecting")).toThrow();
    expect(() => sessionTransitionInputSchema.parse({ eventId: "session-event-1", sessionId: "session-1", expectedVersion: 1, targetStatus: "confirmed", statePatch: { providerPayload: "no" }, missingFields: [], actorUserId: "admin", correlationId, occurredAt: timestamp, metadata: {} })).toThrow();
  });
});

describe("bounded intake errors", () => {
  it("maps every catalogued error to an explicit safe response", () => {
    const codes = [
      "INTAKE_PAYLOAD_INVALID", "INTAKE_CHANNEL_UNAVAILABLE", "INTAKE_IDENTITY_HASH_MISMATCH",
      "INTAKE_SENSITIVE_DATA_REJECTED", "INTAKE_CANONICAL_NUMBER_INVALID", "INTAKE_TARGET_REFERENCE_INVALID",
      "INTAKE_EVENT_REPLAY_MISMATCH", "INTAKE_MESSAGE_REPLAY_MISMATCH", "INTAKE_ATTACHMENT_REPLAY_MISMATCH",
      "INTAKE_ATTACHMENT_DUPLICATE_IN_EVENT", "INTAKE_STORAGE_INTEGRITY_ERROR",
      "INTAKE_REPLY_MESSAGE_INVALID", "INTAKE_CONVERSATION_NOT_FOUND", "INTAKE_CONVERSATION_VERSION_CONFLICT",
      "INTAKE_CONVERSATION_TRANSITION_INVALID", "INTAKE_SESSION_NOT_FOUND", "INTAKE_SESSION_VERSION_CONFLICT",
      "INTAKE_SESSION_TRANSITION_INVALID", "INTAKE_IDENTITY_BINDING_INVALID", "INTEGRATION_OUTBOX_PAYLOAD_INVALID",
      "INTEGRATION_OUTBOX_IDEMPOTENCY_CONFLICT", "INTAKE_RELATIONAL_BACKEND_REQUIRED", "INTAKE_STORAGE_ERROR",
    ] as const;
    for (const code of codes) {
      const mapped = intakeErrorFromUnknown(Object.assign(new Error("database detail must not escape"), { code }));
      expect(mapped).toBeInstanceOf(IntakeCoreError);
      expect(mapped.code).toBe(code);
      const serialized = serializeIntakeError(mapped);
      expect(serialized.code).toBe(code);
      expect(serialized.error).not.toMatch(/database detail|support_|select /i);
    }
  });
});

describe("Email Intake compatibility bridge", () => {
  it("derives hashes from complete normalized material and remains pure", () => {
    const record = createAggregate().toRecord();
    const original = structuredClone(record);
    const persist = vi.fn(); const enqueue = vi.fn();
    const baseline = mapEmailIntakeToUnifiedCommand(record, { id: "email-channel-1", channelKey: "support-mailbox" });
    const subject = mapEmailIntakeToUnifiedCommand({ ...record, subject: "Changed subject" }, { id: "email-channel-1", channelKey: "support-mailbox" });
    const sender = mapEmailIntakeToUnifiedCommand({ ...record, sender: { ...record.sender, address: "other@example.com" } }, { id: "email-channel-1", channelKey: "support-mailbox" });
    const direction = mapEmailIntakeToUnifiedCommand({ ...record, direction: "outbound" }, { id: "email-channel-1", channelKey: "support-mailbox" });
    const attachment = mapEmailIntakeToUnifiedCommand({ ...record, attachmentSummary: record.attachmentSummary.map((item) => ({ ...item, sizeBytes: item.sizeBytes + 1 })) }, { id: "email-channel-1", channelKey: "support-mailbox" });
    expect(subject.event.payloadHash).not.toBe(baseline.event.payloadHash);
    expect(sender.message.contentHash).not.toBe(baseline.message.contentHash);
    expect(direction.message.contentHash).not.toBe(baseline.message.contentHash);
    expect(attachment.message.contentHash).not.toBe(baseline.message.contentHash);
    expect(record).toEqual(original); expect(persist).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
  });
});
