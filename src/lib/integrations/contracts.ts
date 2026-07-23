export const integrationProviders = ["email", "n8n", "servicenow", "internal", "line", "web", "freshservice"] as const;
export type IntegrationProvider = (typeof integrationProviders)[number];

export const integrationOperations = [
  "message.receive",
  "message.normalize",
  "ticket.link",
  "provider.test",
  "ticket.list",
  "ticket.read",
  "ticket.create",
  "ticket.update",
  "ticket.comment",
  "ticket.work_note",
  "event.handle",
] as const;
export type IntegrationOperation = (typeof integrationOperations)[number];

export const integrationEventTypes = [
  "message.received",
  "message.normalized",
  "ticket.link.requested",
  "ticket.linked",
  "integration.failed",
] as const;
export type IntegrationEventType = (typeof integrationEventTypes)[number];

export const integrationErrorCategories = [
  "validation",
  "authentication",
  "authorization",
  "rate_limit",
  "unavailable",
  "timeout",
  "conflict",
  "duplicate",
  "unsupported",
  "malformed_response",
  "internal",
] as const;
export type IntegrationErrorCategory = (typeof integrationErrorCategories)[number];

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type ExternalMessageId = Brand<string, "ExternalMessageId">;
export type ExternalThreadId = Brand<string, "ExternalThreadId">;
export type ExternalTicketId = Brand<string, "ExternalTicketId">;
export type IntegrationEventId = Brand<string, "IntegrationEventId">;
export type IntegrationCorrelationId = Brand<string, "IntegrationCorrelationId">;
export type IntegrationIdempotencyKey = Brand<string, "IntegrationIdempotencyKey">;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type IntegrationFailure = {
  category: IntegrationErrorCategory;
  code: string;
  safeMessage: string;
  retryable: boolean;
  provider: IntegrationProvider;
  operation: IntegrationOperation;
  correlationId: IntegrationCorrelationId;
};

export type IntegrationResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; error: IntegrationFailure };

export type IntegrationInvocationContext = {
  correlationId: IntegrationCorrelationId;
  idempotencyKey: IntegrationIdempotencyKey;
  attempt: number;
  signal?: AbortSignal;
};

export interface IntegrationConnector<Input, Output> {
  readonly provider: IntegrationProvider;
  readonly operation: IntegrationOperation;
  execute(input: Input, context: IntegrationInvocationContext): Promise<IntegrationResult<Output>>;
}

export type IntegrationInvocationRecord = {
  provider: IntegrationProvider;
  operation: IntegrationOperation;
  correlationId: IntegrationCorrelationId;
  idempotencyKey: IntegrationIdempotencyKey;
  attempt: number;
  aborted: boolean;
};
