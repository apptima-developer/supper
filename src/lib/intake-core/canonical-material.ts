import { createHash } from "node:crypto";
import { hashExternalIdentity } from "./identity";
import {
  acceptInboundEventInputSchema, acceptInboundEventSchema,
  type AcceptInboundEvent, type AcceptInboundEventInput, type AttachmentInput,
} from "./schemas";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function canonicalJson(value: unknown, depth: number, ancestors: WeakSet<object>): string {
  if (depth > 16) throw new TypeError("Canonical intake material exceeds the maximum depth");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical intake material contains a non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (value === undefined || typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("Canonical intake material contains a non-JSON value");
  }
  if (!value || typeof value !== "object") throw new TypeError("Canonical intake material is invalid");
  if (ancestors.has(value)) throw new TypeError("Canonical intake material contains a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1, ancestors)).join(",")}]`;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Canonical intake material must use plain JSON objects");
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) throw new TypeError("Canonical intake material contains a symbol key");
    return `{${(keys as string[]).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set || descriptor.value === undefined) {
        throw new TypeError("Canonical intake material contains an accessor or undefined value");
      }
      return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, depth + 1, ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalSerializeIntakeMaterial(value: JsonValue) {
  const serialized = canonicalJson(value, 0, new WeakSet());
  if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) throw new TypeError("Canonical intake material is too large");
  return serialized;
}

export function hashCanonicalIntakeMaterial(value: JsonValue) {
  return createHash("sha256").update(canonicalSerializeIntakeMaterial(value), "utf8").digest("hex");
}

export function canonicalIntakeAttachmentMaterial(attachment: AttachmentInput) {
  return {
    externalAttachmentId: attachment.externalAttachmentId ?? null,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    declaredSize: attachment.declaredSize,
    sha256: attachment.sha256 ?? null,
    providerLocator: attachment.providerLocator ?? null,
    storageStatus: attachment.storageStatus,
    scanStatus: attachment.scanStatus,
    retentionUntil: attachment.retentionUntil ?? null,
    metadata: attachment.metadata,
  } satisfies JsonValue;
}

function canonicalAttachments(input: AcceptInboundEventInput) {
  return input.attachments
    .map(canonicalIntakeAttachmentMaterial)
    .sort((left, right) => Buffer.compare(
      Buffer.from(canonicalSerializeIntakeMaterial(left), "utf8"),
      Buffer.from(canonicalSerializeIntakeMaterial(right), "utf8"),
    ));
}

export function canonicalIntakeMessageMaterial(input: AcceptInboundEventInput) {
  return {
    channel: { id: input.channel.id, provider: input.channel.provider, channelKey: input.channel.channelKey },
    externalConversationId: input.conversation.externalConversationId,
    externalMessageId: input.message.externalMessageId,
    senderExternalSubjectId: input.identity.externalSubjectId,
    direction: input.message.direction,
    messageType: input.message.messageType,
    replyToMessageId: input.message.replyToMessageId ?? null,
    bodyText: input.message.bodyText,
    bodyHtml: input.message.bodyHtml,
    structuredContent: input.message.structuredContent,
    providerSentAt: input.message.providerSentAt ?? null,
    attachments: canonicalAttachments(input),
  } satisfies JsonValue;
}

export function canonicalIntakeEventMaterial(input: AcceptInboundEventInput) {
  return {
    channel: { id: input.channel.id, provider: input.channel.provider, channelKey: input.channel.channelKey },
    externalEventId: input.event.externalEventId,
    eventType: input.event.eventType,
    eventMetadata: input.event.metadata,
    externalIdentity: {
      externalSubjectId: input.identity.externalSubjectId,
      displayName: input.identity.displayName,
      identityType: input.identity.identityType,
      metadata: input.identity.metadata,
    },
    conversation: {
      externalConversationId: input.conversation.externalConversationId,
      subject: input.conversation.subject,
      openedAt: input.conversation.openedAt,
      lastActivityAt: input.conversation.lastActivityAt,
      metadata: input.conversation.metadata,
    },
    message: canonicalIntakeMessageMaterial(input),
    attachments: canonicalAttachments(input),
    initializeSession: input.initializeSession ? {
      status: input.initializeSession.status,
      stateData: input.initializeSession.stateData,
      missingFields: input.initializeSession.missingFields,
      startedAt: input.initializeSession.startedAt,
      expiresAt: input.initializeSession.expiresAt ?? null,
      metadata: input.initializeSession.metadata,
    } : null,
  } satisfies JsonValue;
}

export function prepareCanonicalIntakeEvent(input: unknown): AcceptInboundEvent {
  const draft = acceptInboundEventInputSchema.parse(input);
  const expected = {
    externalSubjectHash: hashExternalIdentity(draft.identity.externalSubjectId),
    contentHash: hashCanonicalIntakeMaterial(canonicalIntakeMessageMaterial(draft)),
    payloadHash: hashCanonicalIntakeMaterial(canonicalIntakeEventMaterial(draft)),
  };
  if ((draft.identity.externalSubjectHash && draft.identity.externalSubjectHash !== expected.externalSubjectHash)
    || (draft.message.contentHash && draft.message.contentHash !== expected.contentHash)
    || (draft.event.payloadHash && draft.event.payloadHash !== expected.payloadHash)) {
    throw new TypeError("Caller-supplied intake hash does not match canonical material");
  }
  return acceptInboundEventSchema.parse({
    ...draft,
    event: { ...draft.event, payloadHash: expected.payloadHash },
    identity: { ...draft.identity, externalSubjectHash: expected.externalSubjectHash },
    message: { ...draft.message, contentHash: expected.contentHash },
  });
}
