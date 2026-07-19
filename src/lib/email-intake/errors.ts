import {
  IntegrationBoundaryError,
  type IntegrationCorrelationId,
  type IntegrationOperation,
  type IntegrationProvider,
} from "../integrations";

type ErrorContext = {
  correlationId: IntegrationCorrelationId;
  provider?: IntegrationProvider;
  operation?: IntegrationOperation;
};

export class DuplicateEmailIntake extends IntegrationBoundaryError {
  constructor(context: ErrorContext) {
    super({
      category: "duplicate",
      code: "DUPLICATE_EMAIL_INTAKE",
      safeMessage: "The external message already has an email intake record",
      retryable: false,
      provider: context.provider ?? "internal",
      operation: context.operation ?? "message.receive",
      correlationId: context.correlationId,
    });
    this.name = "DuplicateEmailIntake";
  }
}

export class InvalidStatusTransition extends IntegrationBoundaryError {
  constructor(context: ErrorContext) {
    super({
      category: "conflict",
      code: "INVALID_EMAIL_INTAKE_STATUS_TRANSITION",
      safeMessage: "The requested email intake status transition is not allowed",
      retryable: false,
      provider: context.provider ?? "internal",
      operation: context.operation ?? "event.handle",
      correlationId: context.correlationId,
    });
    this.name = "InvalidStatusTransition";
  }
}

export class EmailIntakeNotFound extends IntegrationBoundaryError {
  constructor(context: ErrorContext) {
    super({
      category: "validation",
      code: "EMAIL_INTAKE_NOT_FOUND",
      safeMessage: "The requested email intake record was not found",
      retryable: false,
      provider: context.provider ?? "internal",
      operation: context.operation ?? "event.handle",
      correlationId: context.correlationId,
    });
    this.name = "EmailIntakeNotFound";
  }
}
