import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  IntegrationBoundaryError,
  canRetry,
  canonicalSerializeIdempotencyMaterial,
  correlationIdSchema,
  createIntegrationEvent,
  deriveIdempotencyKey,
  deriveMessageIdempotencyKey,
  externalMessageIdSchema,
  externalThreadIdSchema,
  externalTicketIdSchema,
  idempotencyKeySchema,
  integrationErrorCategories,
  integrationProviderSchema,
  integrationEventIdSchema,
  isIntegrationBoundaryError,
  normalizeExternalTicketReference,
  normalizeIntegrationError,
  normalizeIntegrationEvent,
  normalizeMessageEnvelope,
  normalizeRetryMetadata,
  serializeIntegrationErrorForLog,
  serializeIntegrationErrorForPublic,
  type IntegrationEventCreationInput,
} from "./index";
import { InMemoryIntegrationConnector } from "./in-memory-adapter";

const correlationId = correlationIdSchema.parse("request-1234");
const externalMessageId = externalMessageIdSchema.parse("message-42");
const idempotencyKey = deriveMessageIdempotencyKey({
  provider: "email",
  operation: "message.receive",
  externalMessageId,
});

function messageInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0",
    provider: "email",
    operation: "message.normalize",
    externalMessageId,
    correlationId,
    idempotencyKey,
    direction: "inbound",
    sender: { address: " Agent@Example.COM ", displayName: "Agent One" },
    recipients: [{ address: "support@example.com" }],
    replyTo: { address: "reply@example.com" },
    subject: "Support request",
    textBody: "Untrusted message body",
    htmlBody: "<script>opaque()</script>",
    headers: { "Message-ID": "<message-42@example.com>" },
    attachments: [{
      externalAttachmentId: "attachment-1",
      filename: "evidence.png",
      contentType: "image/png",
      sizeBytes: 1024,
      checksum: `sha256:${"a".repeat(64)}`,
    }],
    receivedAt: "2026-07-18T10:20:30+07:00",
    metadata: { mailbox: "support" },
    ...overrides,
  };
}

describe("normalized integration envelopes", () => {
  it("extends providers additively for unified intake without removing existing identifiers", () => {
    for (const provider of ["email", "n8n", "servicenow", "internal", "line", "web", "freshservice"]) {
      expect(integrationProviderSchema.parse(provider)).toBe(provider);
    }
    expect(() => integrationProviderSchema.parse("unsupported-provider")).toThrow();
  });
  it("normalizes addresses, headers, and dates without mutating the source", () => {
    const source = messageInput();
    const normalized = normalizeMessageEnvelope(source);

    expect(normalized.sender.address).toBe("agent@example.com");
    expect(normalized.headers).toEqual({ "message-id": "<message-42@example.com>" });
    expect(normalized.receivedAt).toBe("2026-07-18T03:20:30.000Z");
    expect(normalized.htmlBody).toBe("<script>opaque()</script>");
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.attachments)).toBe(true);
    expect((source.sender as { address: string }).address).toBe(" Agent@Example.COM ");
    (source.metadata as { mailbox: string }).mailbox = "changed";
    expect(normalized.metadata).toEqual({ mailbox: "support" });
  });

  it("rejects CRLF injection in addresses, display names, subjects, and headers", () => {
    expect(() => normalizeMessageEnvelope(messageInput({ sender: { address: "agent@example.com\r\nBcc:x@example.com" } }))).toThrow();
    expect(() => normalizeMessageEnvelope(messageInput({ sender: { address: "agent@example.com", displayName: "Agent\nBcc" } }))).toThrow();
    expect(() => normalizeMessageEnvelope(messageInput({ subject: "Support\r\nBcc: hidden@example.com" }))).toThrow();
    expect(() => normalizeMessageEnvelope(messageInput({ headers: { "message-id": "safe\r\nX-Injected: yes" } }))).toThrow();
  });

  it("rejects sensitive and non-allowlisted headers", () => {
    expect(() => normalizeMessageEnvelope(messageInput({ headers: { Authorization: "Bearer secret" } }))).toThrow(/Sensitive/);
    expect(() => normalizeMessageEnvelope(messageInput({ headers: { "x-provider-dump": "opaque" } }))).toThrow(/allowlisted/);
  });

  it("accepts attachment metadata only and rejects paths or binary-like fields", () => {
    expect(() => normalizeMessageEnvelope(messageInput({
      attachments: [{
        externalAttachmentId: "attachment-1",
        filename: "../secret.txt",
        contentType: "text/plain",
        sizeBytes: 20,
      }],
    }))).toThrow();
    expect(() => normalizeMessageEnvelope(messageInput({
      attachments: [{ externalAttachmentId: "attachment-1", filename: "safe.txt", contentType: "text/plain", sizeBytes: -1 }],
    }))).toThrow();
    expect(() => normalizeMessageEnvelope(messageInput({
      attachments: [{ externalAttachmentId: "attachment-1", filename: "safe.txt", contentType: "text/plain", sizeBytes: 1024 * 1024 * 1024 + 1 }],
    }))).toThrow();
    expect(() => normalizeMessageEnvelope(messageInput({
      attachments: [{
        externalAttachmentId: "attachment-1",
        filename: "safe.txt",
        contentType: "text/plain",
        sizeBytes: 20,
        base64: "c2VjcmV0",
      }],
    }))).toThrow();
  });

  it("enforces explicit recipient, subject, body, and attachment bounds", () => {
    expect(() => normalizeMessageEnvelope(messageInput({ subject: "x".repeat(501) }))).toThrow();
    expect(() => normalizeMessageEnvelope(messageInput({ textBody: "x".repeat(200_001) }))).toThrow();
    expect(() => normalizeMessageEnvelope(messageInput({
      recipients: Array.from({ length: 101 }, (_, index) => ({ address: `agent${index}@example.com` })),
    }))).toThrow();
    expect(() => normalizeMessageEnvelope(messageInput({
      attachments: Array.from({ length: 51 }, (_, index) => ({
        externalAttachmentId: `attachment-${index}`,
        filename: `file-${index}.txt`,
        contentType: "text/plain",
        sizeBytes: 1,
      })),
    }))).toThrow();
  });

  it("supports messages without a subject while retaining explicit direction", () => {
    const source = messageInput();
    delete (source as { subject?: string }).subject;
    const normalized = normalizeMessageEnvelope(source);
    expect(normalized.subject).toBeUndefined();
    expect(normalized.direction).toBe("inbound");
  });

  it("rejects unsafe, oversized, deep, and prototype-polluting metadata", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => normalizeMessageEnvelope(messageInput({ metadata: { value: Number.POSITIVE_INFINITY } }))).toThrow();
    expect(() => normalizeMessageEnvelope(messageInput({ metadata: { value: "x".repeat(1001) } }))).toThrow();
    expect(() => normalizeMessageEnvelope(messageInput({
      metadata: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`key${index}`, "x".repeat(900)])),
    }))).toThrow(/encoded size/);
    expect(() => normalizeMessageEnvelope(messageInput({ metadata: { a: { b: { c: { d: { e: { f: "too deep" } } } } } } }))).toThrow();
    expect(() => normalizeMessageEnvelope(messageInput({ metadata: JSON.parse('{"__proto__":{"polluted":true}}') }))).toThrow(/forbidden/);
    expect(() => normalizeMessageEnvelope(messageInput({ metadata: circular }))).toThrow();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects accessors and non-plain metadata objects", () => {
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, "value", { enumerable: true, get: () => "unsafe" });
    expect(() => normalizeMessageEnvelope(messageInput({ metadata: accessor }))).toThrow(/accessors/);
    expect(() => normalizeMessageEnvelope(messageInput({ metadata: new Date() }))).toThrow(/plain objects/);
  });
});

describe("external ticket references", () => {
  const ticket = { provider: "servicenow", externalTicketId: externalTicketIdSchema.parse("INC001"), correlationId };

  it("allows HTTPS and rejects credentials and other schemes", () => {
    expect(normalizeExternalTicketReference({ ...ticket, externalUrl: "https://tickets.example.com/INC001" }).externalUrl).toContain("https://");
    expect(() => normalizeExternalTicketReference({ ...ticket, externalUrl: "https://user:password@tickets.example.com/INC001" })).toThrow(/credentials/);
    expect(() => normalizeExternalTicketReference({ ...ticket, externalUrl: "ftp://tickets.example.com/INC001" })).toThrow(/HTTPS/);
  });

  it("permits localhost HTTP only when explicitly enabled", () => {
    expect(() => normalizeExternalTicketReference({ ...ticket, externalUrl: "http://localhost:3000/tickets/INC001" })).toThrow(/HTTPS/);
    expect(normalizeExternalTicketReference(
      { ...ticket, externalUrl: "http://localhost:3000/tickets/INC001" },
      { allowLocalhostHttp: true },
    ).externalUrl).toContain("localhost");
    expect(() => normalizeExternalTicketReference(
      { ...ticket, externalUrl: "http://tickets.example.com/INC001" },
      { allowLocalhostHttp: true },
    )).toThrow(/HTTPS/);
  });

  it("normalizes sync timestamps and bounds provider-neutral metadata", () => {
    const normalized = normalizeExternalTicketReference({
      ...ticket,
      externalTicketNumber: "REQ-001",
      lastKnownState: "open",
      lastSyncedAt: "2026-07-18T07:30:00+07:00",
      metadata: { sourceRevision: 3 },
    });
    expect(normalized.lastSyncedAt).toBe("2026-07-18T00:30:00.000Z");
    expect(() => normalizeExternalTicketReference({ ...ticket, externalTicketId: "\u0000" })).toThrow();
    expect(() => normalizeExternalTicketReference({ ...ticket, lastSyncedAt: "yesterday" })).toThrow();
    expect(() => normalizeExternalTicketReference({ ...ticket, metadata: { value: "x".repeat(1001) } })).toThrow();
  });
});

describe("integration events", () => {
  const eventInput: IntegrationEventCreationInput = {
    eventType: "message.received",
    provider: "email",
    operation: "message.receive",
    correlationId,
    idempotencyKey,
    attempt: 1,
    metadata: { contractOnly: true },
    payload: { externalMessageId, rawReference: "mailbox:item-42" },
  };

  it("creates deterministic, versioned events using injected dependencies", () => {
    const event = createIntegrationEvent(eventInput, {
      now: () => new Date("2026-07-18T00:00:00.000Z"),
      createEventId: () => "event-1234",
    });
    expect(event).toMatchObject({
      schemaVersion: "1.0",
      eventId: "event-1234",
      eventType: "message.received",
      occurredAt: "2026-07-18T00:00:00.000Z",
    });
    expect(Object.isFrozen(event.payload)).toBe(true);
  });

  it("validates every supported discriminated event payload", () => {
    const base = {
      schemaVersion: "1.0",
      eventId: "event-1234",
      provider: "internal",
      operation: "event.handle",
      correlationId,
      idempotencyKey,
      attempt: 1,
      occurredAt: "2026-07-18T00:00:00.000Z",
    };
    const ticket = { provider: "servicenow", externalTicketId: "INC001", externalUrl: "https://tickets.example.com/INC001", correlationId };
    const events = [
      { ...base, eventType: "message.received", payload: { externalMessageId } },
      { ...base, eventType: "message.normalized", payload: { message: messageInput() } },
      { ...base, eventType: "ticket.link.requested", payload: { externalMessageId, ticket } },
      { ...base, eventType: "ticket.linked", payload: { externalMessageId, ticket } },
      { ...base, eventType: "integration.failed", payload: { error: {
        category: "timeout",
        code: "UPSTREAM_TIMEOUT",
        safeMessage: "The provider timed out",
        retryable: true,
        provider: "email",
        operation: "message.receive",
        correlationId,
      } } },
    ];
    for (const event of events) expect(normalizeIntegrationEvent(event).eventType).toBe(event.eventType);
  });

  it("rejects unknown event types and malformed payloads", () => {
    expect(() => normalizeIntegrationEvent({
      schemaVersion: "1.0",
      eventId: "event-1234",
      eventType: "message.deleted",
      provider: "internal",
      operation: "event.handle",
      correlationId,
      idempotencyKey,
      attempt: 1,
      occurredAt: "2026-07-18T00:00:00.000Z",
      payload: {},
    })).toThrow();
    expect(() => normalizeIntegrationEvent({
      ...createIntegrationEvent(eventInput, {
        now: () => new Date("2026-07-18T00:00:00.000Z"),
        createEventId: () => "event-1234",
      }),
      schemaVersion: "2.0",
    })).toThrow();
    expect(() => normalizeIntegrationEvent({
      ...createIntegrationEvent(eventInput, {
        now: () => new Date("2026-07-18T00:00:00.000Z"),
        createEventId: () => "event-1234",
      }),
      attempt: 0,
    })).toThrow();
    expect(() => createIntegrationEvent({ ...eventInput, payload: {} } as IntegrationEventCreationInput, {
      now: () => new Date("2026-07-18T00:00:00.000Z"),
      createEventId: () => "event-1234",
    })).toThrow();
  });
});

describe("idempotency", () => {
  it("uses stable object ordering while preserving array order", () => {
    const first = { kind: "message" as const, provider: "email" as const, operation: "message.receive" as const, externalMessageId };
    const reordered = { externalMessageId, operation: "message.receive" as const, provider: "email" as const, kind: "message" as const };
    expect(deriveIdempotencyKey(first)).toBe(deriveIdempotencyKey(reordered));
    expect(deriveMessageIdempotencyKey({ ...first, externalMessageId: externalMessageIdSchema.parse("message-43") })).not.toBe(
      deriveMessageIdempotencyKey(first),
    );
    expect(canonicalSerializeIdempotencyMaterial([2, 3])).not.toBe(canonicalSerializeIdempotencyMaterial([3, 2]));
  });

  it("handles undefined deterministically without colliding with missing keys", () => {
    expect(canonicalSerializeIdempotencyMaterial({ value: undefined })).toBe(canonicalSerializeIdempotencyMaterial({ value: undefined }));
    expect(canonicalSerializeIdempotencyMaterial({ value: undefined })).not.toBe(canonicalSerializeIdempotencyMaterial({}));
    expect(idempotencyKeySchema.parse(deriveMessageIdempotencyKey({
      provider: "email",
      operation: "message.receive",
      externalMessageId,
    }))).toMatch(/^supper:v1:/);
  });

  it("rejects cycles, non-finite numbers, BigInt, functions, symbols, and non-plain objects", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const invalid of [
      circular,
      { value: Number.NaN },
      { value: BigInt(1) },
      { value: () => undefined },
      { value: Symbol("x") },
      { value: new Date() },
    ]) expect(() => canonicalSerializeIdempotencyMaterial(invalid)).toThrow(TypeError);
  });

  it("rejects bodies, secrets, and arbitrary fields from key material", () => {
    expect(() => deriveIdempotencyKey({
      kind: "message",
      provider: "email",
      operation: "message.receive",
      externalMessageId,
      body: "must-not-be-hashed",
    } as never)).toThrow();
    expect(deriveMessageIdempotencyKey({
      provider: "email",
      operation: "message.receive",
      externalMessageId,
    })).toMatch(/^supper:v1:[a-f0-9]{64}$/);
  });
});

describe("retry policy", () => {
  it("validates chronology and applies a pure bounded retry decision", () => {
    const metadata = normalizeRetryMetadata({
      attempt: 2,
      maxAttempts: 3,
      firstAttemptAt: "2026-07-18T00:00:00.000Z",
      lastAttemptAt: "2026-07-18T00:01:00.000Z",
      nextAttemptAt: "2026-07-18T00:02:00.000Z",
      retryable: true,
      reasonCode: "UPSTREAM_TIMEOUT",
    });
    expect(canRetry(metadata)).toBe(true);
    expect(canRetry({ ...metadata, attempt: 3 })).toBe(false);
    expect(canRetry({ ...metadata, retryable: false })).toBe(false);
    expect(() => normalizeRetryMetadata({ ...metadata, attempt: 4 })).toThrow();
    expect(() => normalizeRetryMetadata({ ...metadata, lastAttemptAt: "2026-07-17T23:59:00.000Z" })).toThrow();
    expect(() => normalizeRetryMetadata({ ...metadata, reasonCode: "provider said no" })).toThrow();
  });
});

describe("safe integration errors", () => {
  function boundaryError(category: (typeof integrationErrorCategories)[number] = "internal") {
    return new IntegrationBoundaryError({
      category,
      code: "PROVIDER_FAILURE",
      safeMessage: "The integration operation failed",
      retryable: category === "timeout" || category === "unavailable" || category === "rate_limit",
      provider: "email",
      operation: "message.receive",
      correlationId,
      cause: new Error("secret provider response with token"),
    });
  }

  it("supports every error category with explicit safe serializers", () => {
    for (const category of integrationErrorCategories) {
      const error = boundaryError(category);
      expect(serializeIntegrationErrorForPublic(error).category).toBe(category);
      expect(serializeIntegrationErrorForLog(error).errorType).toBe("IntegrationBoundaryError");
      expect(JSON.stringify(serializeIntegrationErrorForLog(error))).not.toContain("secret provider response");
    }
  });

  it("retains causes internally without serializing cause, stack, or provider data", () => {
    const error = boundaryError("internal");
    expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
    expect(Object.keys(error)).not.toContain("cause");
    expect(JSON.stringify(error)).toBe("{}");
    expect(serializeIntegrationErrorForPublic(error)).not.toHaveProperty("stack");
    expect(serializeIntegrationErrorForLog(error)).not.toHaveProperty("cause");
  });

  it("normalizes Error, string, unknown, and circular throwables without leaking them", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const fallback = {
      category: "internal" as const,
      code: "UNEXPECTED_FAILURE",
      safeMessage: "The integration operation failed",
      retryable: false,
      provider: "internal" as const,
      operation: "event.handle" as const,
      correlationId,
    };
    for (const thrown of [new Error("password=secret"), "token=secret", circular, null]) {
      const normalized = normalizeIntegrationError(thrown, fallback);
      expect(isIntegrationBoundaryError(normalized)).toBe(true);
      expect(JSON.stringify(normalized.toLog())).not.toContain("secret");
    }
    const original = boundaryError();
    expect(normalizeIntegrationError(original, fallback)).toBe(original);
  });
});

describe("in-memory connector test adapter", () => {
  it("returns cloned configured results and records only sanitized invocation metadata", async () => {
    const configured = { ok: true as const, value: { status: "linked", nested: { count: 1 } } };
    const connector = new InMemoryIntegrationConnector<{ secretBody: string }, typeof configured.value>({
      provider: "internal",
      operation: "ticket.link",
      results: [configured],
    });
    configured.value.nested.count = 99;
    const callerInput = { secretBody: "customer data" };
    const result = await connector.execute(callerInput, {
      correlationId,
      idempotencyKey,
      attempt: 1,
    });

    expect(result).toEqual({ ok: true, value: { status: "linked", nested: { count: 1 } } });
    expect(callerInput).toEqual({ secretBody: "customer data" });
    if (result.ok) result.value.nested.count = 7;
    const second = await connector.execute({ secretBody: "different customer data" }, {
      correlationId,
      idempotencyKey,
      attempt: 2,
    });
    expect(second).toEqual({ ok: true, value: { status: "linked", nested: { count: 1 } } });
    expect(JSON.stringify(connector.invocations)).not.toContain("customer data");
    expect(connector.invocations).toHaveLength(2);
  });

  it("respects an already-aborted signal without returning the configured success", async () => {
    const controller = new AbortController();
    controller.abort();
    const connector = new InMemoryIntegrationConnector<unknown, string>({
      provider: "email",
      operation: "message.receive",
      results: [{ ok: true, value: "should-not-return" }],
    });
    const result = await connector.execute(null, {
      correlationId,
      idempotencyKey,
      attempt: 1,
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("OPERATION_ABORTED");
    expect(connector.invocations[0].aborted).toBe(true);
  });

  it("simulates a typed failure without throwing", async () => {
    const failure = new IntegrationBoundaryError({
      category: "unavailable",
      code: "PROVIDER_UNAVAILABLE",
      safeMessage: "The provider is unavailable",
      retryable: true,
      provider: "servicenow",
      operation: "ticket.link",
      correlationId,
    }).toPublic();
    const connector = new InMemoryIntegrationConnector<unknown, never>({
      provider: "servicenow",
      operation: "ticket.link",
      results: [{ ok: false, error: failure }],
    });
    await expect(connector.execute(null, { correlationId, idempotencyKey, attempt: 1 })).resolves.toEqual({
      ok: false,
      error: failure,
    });
  });

  it("rejects adapters without a predefined result", () => {
    expect(() => new InMemoryIntegrationConnector<unknown, unknown>({
      provider: "internal",
      operation: "event.handle",
      results: [],
    })).toThrow(TypeError);
  });
});

describe("boundary schema ergonomics", () => {
  it("uses the existing request ID policy for correlations", () => {
    expect(correlationIdSchema.parse("request-1234")).toBe("request-1234");
    expect(() => correlationIdSchema.parse("short")).toThrow(z.ZodError);
    expect(() => correlationIdSchema.parse("request with spaces")).toThrow(z.ZodError);
  });

  it("trims valid IDs and rejects empty, oversized, and control-character IDs", () => {
    const schemas = [externalMessageIdSchema, externalThreadIdSchema, externalTicketIdSchema, integrationEventIdSchema];
    for (const schema of schemas) {
      expect(schema.parse("  external-123  ")).toBe("external-123");
      expect(() => schema.parse("   ")).toThrow(z.ZodError);
      expect(() => schema.parse("x".repeat(201))).toThrow(z.ZodError);
      expect(() => schema.parse("external\u0000id")).toThrow(z.ZodError);
    }
  });
});
