import type {
  IntegrationCorrelationId,
  IntegrationIdempotencyKey,
} from "../integrations";
import type { EmailIntakeStatus } from "./schemas";

export const emailIntakeEventTypes = [
  "EmailIntakeCreated",
  "EmailValidated",
  "EmailQueued",
  "EmailProcessingStarted",
  "EmailClassified",
  "EmailReadyForTicket",
  "EmailCompleted",
  "EmailFailed",
  "EmailRejected",
  "EmailIntakeUpdated",
  "EmailProcessorAssigned",
  "EmailRetryRecorded",
] as const;

export type EmailIntakeEventType = (typeof emailIntakeEventTypes)[number];

type EventBase<Type extends EmailIntakeEventType, Payload> = Readonly<{
  schemaVersion: "1.0";
  eventId: string;
  eventType: Type;
  intakeId: string;
  occurredAt: string;
  correlationId: IntegrationCorrelationId;
  idempotencyKey: IntegrationIdempotencyKey;
  payload: Readonly<Payload>;
}>;

export type EmailIntakeDomainEvent =
  | EventBase<"EmailIntakeCreated", { status: "RECEIVED" }>
  | EventBase<"EmailValidated", { previousStatus: EmailIntakeStatus; status: "VALIDATED" }>
  | EventBase<"EmailQueued", { previousStatus: EmailIntakeStatus; status: "QUEUED" }>
  | EventBase<"EmailProcessingStarted", { previousStatus: EmailIntakeStatus; status: "PROCESSING" }>
  | EventBase<"EmailClassified", { previousStatus: EmailIntakeStatus; status: "CLASSIFIED" }>
  | EventBase<"EmailReadyForTicket", { previousStatus: EmailIntakeStatus; status: "READY_FOR_TICKET" }>
  | EventBase<"EmailCompleted", { previousStatus: EmailIntakeStatus; status: "COMPLETED" }>
  | EventBase<"EmailFailed", { previousStatus: EmailIntakeStatus; status: "FAILED" }>
  | EventBase<"EmailRejected", { previousStatus: EmailIntakeStatus; status: "REJECTED" }>
  | EventBase<"EmailIntakeUpdated", Record<string, never>>
  | EventBase<"EmailProcessorAssigned", { processor: string }>
  | EventBase<"EmailRetryRecorded", { retryCount: number; reasonCode?: string }>;

const statusEventTypes: Record<Exclude<EmailIntakeStatus, "RECEIVED">, EmailIntakeEventType> = {
  VALIDATED: "EmailValidated",
  QUEUED: "EmailQueued",
  PROCESSING: "EmailProcessingStarted",
  CLASSIFIED: "EmailClassified",
  READY_FOR_TICKET: "EmailReadyForTicket",
  COMPLETED: "EmailCompleted",
  FAILED: "EmailFailed",
  REJECTED: "EmailRejected",
};

export function eventTypeForStatus(status: Exclude<EmailIntakeStatus, "RECEIVED">) {
  return statusEventTypes[status];
}
