import { describe, expect, it } from "vitest";
import {
  correlationIdSchema,
  deriveMessageIdempotencyKey,
  externalMessageIdSchema,
} from "../integrations";
import { EmailIntakeAggregate, allowedEmailIntakeTransitions } from "./aggregate";
import { InvalidStatusTransition } from "./errors";
import { context, createAggregate, dependencies, envelope } from "./test-fixtures";

describe("email intake aggregate", () => {
  it("normalizes B2 message envelopes into an immutable first-class record", () => {
    const input = envelope();
    const result = EmailIntakeAggregate.create(input, "system", dependencies());
    const record = result.aggregate.toRecord();

    expect(record).toMatchObject({
      schemaVersion: "1.0",
      currentStatus: "RECEIVED",
      sender: { address: "agent@example.com" },
      retryCount: 0,
    });
    expect(record.attachmentSummary).toHaveLength(1);
    expect(record.attachmentSummary[0]).not.toHaveProperty("base64");
    expect(result.events[0].eventType).toBe("EmailIntakeCreated");
    expect(result.aggregate.auditHistory[0].action).toBe("created");
    expect(Object.isFrozen(result.aggregate.auditHistory)).toBe(true);
    expect(Object.isFrozen(result.events[0].payload)).toBe(true);

    record.subject = "mutated copy";
    record.sender.address = "record-copy@example.com";
    record.recipients.push({ address: "record-copy@example.com" });
    record.attachmentSummary[0].filename = "record-copy.png";
    record.metadata.mailbox = "record-copy";
    input.sender.address = "caller-input@example.com";
    input.recipients[0].address = "caller-input@example.com";
    input.attachments[0].filename = "caller-input.png";
    input.metadata.mailbox = "caller-input";

    expect(result.aggregate.toRecord()).toMatchObject({
      subject: "Support request",
      sender: { address: "agent@example.com" },
      recipients: [{ address: "support@example.com" }],
      attachmentSummary: [{ filename: "evidence.png" }],
      metadata: { mailbox: "support" },
    });
  });

  it("moves only through allowed lifecycle transitions and emits explicit events", () => {
    let aggregate = createAggregate();
    const lifecycle = [
      ["VALIDATED", "EmailValidated"],
      ["QUEUED", "EmailQueued"],
      ["PROCESSING", "EmailProcessingStarted"],
      ["CLASSIFIED", "EmailClassified"],
      ["READY_FOR_TICKET", "EmailReadyForTicket"],
      ["COMPLETED", "EmailCompleted"],
    ] as const;
    for (const [index, [status, eventType]] of lifecycle.entries()) {
      const result = aggregate.transitionTo(status, context(`2026-07-18T03:${22 + index}:00.000Z`));
      expect(result.events[0].eventType).toBe(eventType);
      aggregate = result.aggregate;
    }
    expect(aggregate.currentStatus).toBe("COMPLETED");
    expect(aggregate.auditHistory.filter((entry) => entry.action === "status_changed")).toHaveLength(6);
    expect(() => aggregate.transitionTo("FAILED", context("2026-07-18T04:00:00.000Z"))).toThrow(InvalidStatusTransition);
  });

  it("rejects direct jumps and exposes lifecycle rules without mutable references", () => {
    const aggregate = createAggregate();
    try {
      aggregate.transitionTo("COMPLETED", context("2026-07-18T03:22:00.000Z"));
      throw new Error("Expected status transition to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStatusTransition);
      const transition = error as InvalidStatusTransition;
      expect(transition.sourceStatus).toBe("RECEIVED");
      expect(transition.targetStatus).toBe("COMPLETED");
      expect(Object.keys(transition)).not.toContain("sourceStatus");
      expect(transition.toPublic()).not.toHaveProperty("sourceStatus");
    }
    const transitions = allowedEmailIntakeTransitions("RECEIVED");
    transitions.length = 0;
    expect(allowedEmailIntakeTransitions("RECEIVED")).toEqual(["VALIDATED", "FAILED", "REJECTED"]);
  });

  it("tracks revision, processor assignment, failure, and retry audit records", () => {
    let aggregate = createAggregate();
    let result = aggregate.revise({ subject: "Updated support request", metadata: { classification: "manual" } }, context("2026-07-18T03:22:00.000Z"));
    aggregate = result.aggregate;
    expect(result.events[0].eventType).toBe("EmailIntakeUpdated");
    result = aggregate.assignProcessor("processor-1", context("2026-07-18T03:23:00.000Z"));
    aggregate = result.aggregate;
    expect(result.events[0]).toMatchObject({ eventType: "EmailProcessorAssigned", payload: { processor: "processor-1" } });
    aggregate = aggregate.transitionTo("FAILED", context("2026-07-18T03:24:00.000Z")).aggregate;
    result = aggregate.recordRetry("TRANSIENT_FAILURE", context("2026-07-18T03:25:00.000Z"));

    expect(result.aggregate.retryCount).toBe(1);
    expect(result.events[0]).toMatchObject({ eventType: "EmailRetryRecorded", payload: { retryCount: 1, reasonCode: "TRANSIENT_FAILURE" } });
    expect(result.aggregate.auditHistory.at(-1)).toMatchObject({ action: "retry_incremented", processor: "processor-1" });
  });

  it("rejects invalid correlation, malformed fields, unsafe metadata, binaries, and oversized payloads", () => {
    const aggregate = createAggregate();
    const wrongCorrelation = correlationIdSchema.parse("request-wrong-correlation");
    expect(() => aggregate.revise({}, { ...context("2026-07-18T03:22:00.000Z"), correlationId: wrongCorrelation })).toThrow(/correlation/i);
    expect(() => EmailIntakeAggregate.create(envelope("bad\u0000id"), "system", dependencies())).toThrow();
    expect(() => EmailIntakeAggregate.create(envelope("message-unsafe", { subject: "hello\r\nBcc: x@example.com" }), "system", dependencies())).toThrow();
    expect(() => EmailIntakeAggregate.create(envelope("message-large", { textBody: "x".repeat(200_001) }), "system", dependencies())).toThrow();
    expect(() => EmailIntakeAggregate.create(envelope("message-binary", { attachments: [{
      externalAttachmentId: "attachment-1",
      filename: "safe.txt",
      contentType: "text/plain",
      sizeBytes: 1,
      base64: "c2VjcmV0",
    }] }), "system", dependencies())).toThrow();
    expect(() => EmailIntakeAggregate.create(envelope("message-prototype", {
      metadata: JSON.parse('{"__proto__":{"polluted":true}}'),
    }), "system", dependencies())).toThrow(/forbidden/);
  });

  it("rejects mismatched idempotency and malformed persisted records", () => {
    const externalMessageId = externalMessageIdSchema.parse("message-mismatch");
    const wrong = deriveMessageIdempotencyKey({ provider: "email", operation: "message.receive", externalMessageId: externalMessageIdSchema.parse("other") });
    expect(() => EmailIntakeAggregate.create(envelope(externalMessageId, { idempotencyKey: wrong }), "system", dependencies())).toThrow(/idempotency/i);

    const record = createAggregate().toRecord();
    expect(() => EmailIntakeAggregate.rehydrate({ ...record, currentStatus: "UNKNOWN" })).toThrow();
    expect(() => EmailIntakeAggregate.rehydrate({ ...record, idempotencyKey: wrong })).toThrow(/idempotency/i);
  });
});
