import type { IntegrationEventId } from "./contracts";
import {
  createExternalTicketReferenceSchema,
  integrationEventIdSchema,
  integrationEventSchema,
  normalizedMessageEnvelopeSchema,
  retryMetadataSchema,
  type ExternalTicketReference,
  type IntegrationEvent,
  type IntegrationEventCreationInput,
  type NormalizedMessageEnvelope,
  type RetryMetadata,
} from "./schemas";

function freezeCopy<Value>(value: Value): Value {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) freezeCopy(item);
  return Object.freeze(value);
}

export function normalizeMessageEnvelope(input: unknown): Readonly<NormalizedMessageEnvelope> {
  return freezeCopy(normalizedMessageEnvelopeSchema.parse(input));
}

export function normalizeExternalTicketReference(
  input: unknown,
  options: { allowLocalhostHttp?: boolean } = {},
): Readonly<ExternalTicketReference> {
  return freezeCopy(createExternalTicketReferenceSchema(options).parse(input));
}

export function normalizeIntegrationEvent(input: unknown): Readonly<IntegrationEvent> {
  return freezeCopy(integrationEventSchema.parse(input));
}

export function normalizeRetryMetadata(input: unknown): Readonly<RetryMetadata> {
  return freezeCopy(retryMetadataSchema.parse(input));
}

export function canRetry(metadata: RetryMetadata) {
  return metadata.retryable && metadata.attempt < metadata.maxAttempts;
}

export function createIntegrationEvent(
  input: IntegrationEventCreationInput,
  dependencies: { now: () => Date; createEventId: () => string },
): Readonly<IntegrationEvent> {
  const eventId = integrationEventIdSchema.parse(dependencies.createEventId()) as IntegrationEventId;
  return normalizeIntegrationEvent({
    ...input,
    schemaVersion: "1.0",
    eventId,
    occurredAt: dependencies.now(),
  });
}
