import type {
  IntegrationCorrelationId,
  JsonObject,
} from "../integrations/contracts";
import { IntegrationBoundaryError } from "../integrations/errors";
import { deriveMessageIdempotencyKey } from "../integrations/idempotency";
import { normalizeMessageEnvelope } from "../integrations/normalization";
import { correlationIdSchema, integrationBoundaryLimits } from "../integrations/schemas";
import { InvalidStatusTransition } from "./errors";
import { eventTypeForStatus, type EmailIntakeDomainEvent } from "./events";
import {
  emailIntakeActorSchema,
  emailIntakeAuditIdSchema,
  emailIntakeEventIdSchema,
  emailIntakeIdSchema,
  emailIntakeProcessorSchema,
  emailIntakeReasonCodeSchema,
  emailIntakeRecordSchema,
  normalizedIsoTimestampSchema,
  type EmailIntakeAuditEntry,
  type EmailIntakeRecord,
  type EmailIntakeStatus,
} from "./schemas";

export type EmailIntakeDomainDependencies = {
  now: () => Date;
  createIntakeId: () => string;
  createAuditId: () => string;
  createEventId: () => string;
};

export type EmailIntakeActionContext = {
  correlationId: IntegrationCorrelationId;
  actor: string;
  at: Date;
  createAuditId: () => string;
  createEventId: () => string;
};

export type EmailIntakeMutationResult = Readonly<{
  aggregate: EmailIntakeAggregate;
  events: readonly EmailIntakeDomainEvent[];
}>;

export type EmailIntakeRevision = Readonly<{
  subject?: string | null;
  normalizedText?: string | null;
  normalizedHtml?: string | null;
  metadata?: JsonObject;
}>;

const allowedTransitions: Readonly<Record<EmailIntakeStatus, readonly EmailIntakeStatus[]>> = Object.freeze({
  RECEIVED: ["VALIDATED", "FAILED", "REJECTED"],
  VALIDATED: ["QUEUED", "FAILED", "REJECTED"],
  QUEUED: ["PROCESSING", "FAILED", "REJECTED"],
  PROCESSING: ["CLASSIFIED", "FAILED"],
  CLASSIFIED: ["READY_FOR_TICKET", "FAILED"],
  READY_FOR_TICKET: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: ["QUEUED", "REJECTED"],
  REJECTED: [],
});

function deepFreeze<Value>(value: Value): Value {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function timestamp(date: Date) {
  if (!Number.isFinite(date.getTime())) throw new TypeError("Email intake timestamp is invalid");
  return normalizedIsoTimestampSchema.parse(date.toISOString());
}

function actionContext(context: EmailIntakeActionContext, record: EmailIntakeRecord) {
  const correlationId = correlationIdSchema.parse(context.correlationId);
  if (correlationId !== record.correlationId) {
    throw new IntegrationBoundaryError({
      category: "validation",
      code: "EMAIL_INTAKE_CORRELATION_MISMATCH",
      safeMessage: "Email intake mutation correlation does not match the record",
      retryable: false,
      provider: record.provider,
      operation: "event.handle",
      correlationId,
    });
  }
  return {
    actor: emailIntakeActorSchema.parse(context.actor),
    occurredAt: timestamp(context.at),
    auditId: emailIntakeAuditIdSchema.parse(context.createAuditId()),
    eventId: emailIntakeEventIdSchema.parse(context.createEventId()),
  };
}

function eventBase(record: EmailIntakeRecord, eventId: string, occurredAt: string) {
  return {
    schemaVersion: "1.0" as const,
    eventId,
    intakeId: record.intakeId,
    occurredAt,
    correlationId: record.correlationId,
    idempotencyKey: record.idempotencyKey,
  };
}

function copyRecord(record: EmailIntakeRecord) {
  return structuredClone(record);
}

export class EmailIntakeAggregate {
  readonly #record: EmailIntakeRecord;

  private constructor(record: EmailIntakeRecord) {
    this.#record = deepFreeze(emailIntakeRecordSchema.parse(record));
  }

  static create(
    envelopeInput: unknown,
    actorInput: string,
    dependencies: EmailIntakeDomainDependencies,
  ): EmailIntakeMutationResult {
    const envelope = normalizeMessageEnvelope(envelopeInput);
    const expectedIdempotencyKey = deriveMessageIdempotencyKey({
      provider: envelope.provider,
      operation: "message.receive",
      externalMessageId: envelope.externalMessageId,
    });
    if (envelope.idempotencyKey !== expectedIdempotencyKey) {
      throw new IntegrationBoundaryError({
        category: "validation",
        code: "INVALID_EMAIL_INTAKE_IDEMPOTENCY_KEY",
        safeMessage: "Email intake idempotency does not match the external message identity",
        retryable: false,
        provider: envelope.provider,
        operation: "message.receive",
        correlationId: envelope.correlationId,
      });
    }

    const actor = emailIntakeActorSchema.parse(actorInput);
    const createdAt = timestamp(dependencies.now());
    const intakeId = emailIntakeIdSchema.parse(dependencies.createIntakeId());
    const auditId = emailIntakeAuditIdSchema.parse(dependencies.createAuditId());
    const eventId = emailIntakeEventIdSchema.parse(dependencies.createEventId());
    const audit: EmailIntakeAuditEntry = { auditId, action: "created", occurredAt: createdAt, actor };
    const record = emailIntakeRecordSchema.parse({
      schemaVersion: "1.0",
      intakeId,
      provider: envelope.provider,
      correlationId: envelope.correlationId,
      idempotencyKey: expectedIdempotencyKey,
      externalMessageId: envelope.externalMessageId,
      externalThreadId: envelope.externalThreadId,
      direction: envelope.direction,
      sender: envelope.sender,
      recipients: envelope.recipients,
      cc: envelope.ccRecipients,
      replyTo: envelope.replyTo,
      subject: envelope.subject,
      normalizedText: envelope.textBody,
      normalizedHtml: envelope.htmlBody,
      attachmentSummary: envelope.attachments,
      metadata: envelope.metadata,
      receivedAt: envelope.receivedAt,
      createdAt,
      updatedAt: createdAt,
      currentStatus: "RECEIVED",
      retryCount: 0,
      auditHistory: [audit],
    });
    const aggregate = new EmailIntakeAggregate(record);
    const event: EmailIntakeDomainEvent = deepFreeze({
      ...eventBase(record, eventId, createdAt),
      eventType: "EmailIntakeCreated",
      payload: { status: "RECEIVED" },
    });
    return deepFreeze({ aggregate, events: [event] });
  }

  static rehydrate(input: unknown) {
    return new EmailIntakeAggregate(emailIntakeRecordSchema.parse(input));
  }

  get intakeId() { return this.#record.intakeId; }
  get provider() { return this.#record.provider; }
  get correlationId() { return this.#record.correlationId; }
  get idempotencyKey() { return this.#record.idempotencyKey; }
  get externalMessageId() { return this.#record.externalMessageId; }
  get currentStatus() { return this.#record.currentStatus; }
  get retryCount() { return this.#record.retryCount; }
  get auditHistory() { return this.#record.auditHistory; }

  toRecord() {
    return copyRecord(this.#record);
  }

  transitionTo(nextStatus: EmailIntakeStatus, context: EmailIntakeActionContext): EmailIntakeMutationResult {
    if (!allowedTransitions[this.#record.currentStatus].includes(nextStatus)) {
      throw new InvalidStatusTransition({
        provider: this.#record.provider,
        operation: "event.handle",
        correlationId: this.#record.correlationId,
        sourceStatus: this.#record.currentStatus,
        targetStatus: nextStatus,
      });
    }
    if (nextStatus === "RECEIVED") {
      throw new InvalidStatusTransition({
        provider: this.#record.provider,
        operation: "event.handle",
        correlationId: this.#record.correlationId,
        sourceStatus: this.#record.currentStatus,
        targetStatus: nextStatus,
      });
    }

    const normalized = actionContext(context, this.#record);
    const audit: EmailIntakeAuditEntry = {
      auditId: normalized.auditId,
      action: "status_changed",
      occurredAt: normalized.occurredAt,
      actor: normalized.actor,
      previousStatus: this.#record.currentStatus,
      nextStatus,
    };
    const record = emailIntakeRecordSchema.parse({
      ...this.#record,
      currentStatus: nextStatus,
      updatedAt: normalized.occurredAt,
      auditHistory: [...this.#record.auditHistory, audit],
    });
    const aggregate = new EmailIntakeAggregate(record);
    const event: EmailIntakeDomainEvent = deepFreeze({
      ...eventBase(record, normalized.eventId, normalized.occurredAt),
      eventType: eventTypeForStatus(nextStatus),
      payload: { previousStatus: this.#record.currentStatus, status: nextStatus },
    } as EmailIntakeDomainEvent);
    return deepFreeze({ aggregate, events: [event] });
  }

  revise(revision: EmailIntakeRevision, context: EmailIntakeActionContext): EmailIntakeMutationResult {
    const normalized = actionContext(context, this.#record);
    const next = {
      ...this.#record,
      ...(Object.hasOwn(revision, "subject") ? { subject: revision.subject ?? undefined } : {}),
      ...(Object.hasOwn(revision, "normalizedText") ? { normalizedText: revision.normalizedText ?? undefined } : {}),
      ...(Object.hasOwn(revision, "normalizedHtml") ? { normalizedHtml: revision.normalizedHtml ?? undefined } : {}),
      ...(Object.hasOwn(revision, "metadata") ? { metadata: revision.metadata } : {}),
      updatedAt: normalized.occurredAt,
      auditHistory: [
        ...this.#record.auditHistory,
        { auditId: normalized.auditId, action: "updated" as const, occurredAt: normalized.occurredAt, actor: normalized.actor },
      ],
    };
    const record = emailIntakeRecordSchema.parse(next);
    const aggregate = new EmailIntakeAggregate(record);
    const event: EmailIntakeDomainEvent = deepFreeze({
      ...eventBase(record, normalized.eventId, normalized.occurredAt),
      eventType: "EmailIntakeUpdated",
      payload: {},
    });
    return deepFreeze({ aggregate, events: [event] });
  }

  assignProcessor(processorInput: string, context: EmailIntakeActionContext): EmailIntakeMutationResult {
    const normalized = actionContext(context, this.#record);
    const processor = emailIntakeProcessorSchema.parse(processorInput);
    const record = emailIntakeRecordSchema.parse({
      ...this.#record,
      processor,
      updatedAt: normalized.occurredAt,
      auditHistory: [
        ...this.#record.auditHistory,
        { auditId: normalized.auditId, action: "processor_assigned", occurredAt: normalized.occurredAt, actor: normalized.actor, processor },
      ],
    });
    const aggregate = new EmailIntakeAggregate(record);
    const event: EmailIntakeDomainEvent = deepFreeze({
      ...eventBase(record, normalized.eventId, normalized.occurredAt),
      eventType: "EmailProcessorAssigned",
      payload: { processor },
    });
    return deepFreeze({ aggregate, events: [event] });
  }

  recordRetry(reasonCodeInput: string | undefined, context: EmailIntakeActionContext): EmailIntakeMutationResult {
    if (this.#record.currentStatus !== "FAILED") {
      throw new InvalidStatusTransition({
        provider: this.#record.provider,
        operation: "event.handle",
        correlationId: this.#record.correlationId,
        sourceStatus: this.#record.currentStatus,
        targetStatus: "FAILED",
      });
    }
    if (this.#record.retryCount >= integrationBoundaryLimits.retryAttempts) {
      throw new IntegrationBoundaryError({
        category: "conflict",
        code: "EMAIL_INTAKE_RETRY_LIMIT_REACHED",
        safeMessage: "The email intake retry limit has been reached",
        retryable: false,
        provider: this.#record.provider,
        operation: "event.handle",
        correlationId: this.#record.correlationId,
      });
    }

    const normalized = actionContext(context, this.#record);
    const reasonCode = reasonCodeInput ? emailIntakeReasonCodeSchema.parse(reasonCodeInput) : undefined;
    const retryCount = this.#record.retryCount + 1;
    const audit: EmailIntakeAuditEntry = {
      auditId: normalized.auditId,
      action: "retry_incremented",
      occurredAt: normalized.occurredAt,
      actor: normalized.actor,
      retryCount,
      processor: this.#record.processor,
      reasonCode,
    };
    const record = emailIntakeRecordSchema.parse({
      ...this.#record,
      retryCount,
      updatedAt: normalized.occurredAt,
      auditHistory: [...this.#record.auditHistory, audit],
    });
    const aggregate = new EmailIntakeAggregate(record);
    const event: EmailIntakeDomainEvent = deepFreeze({
      ...eventBase(record, normalized.eventId, normalized.occurredAt),
      eventType: "EmailRetryRecorded",
      payload: { retryCount, ...(reasonCode ? { reasonCode } : {}) },
    });
    return deepFreeze({ aggregate, events: [event] });
  }
}

export function allowedEmailIntakeTransitions(status: EmailIntakeStatus) {
  return [...allowedTransitions[status]];
}
