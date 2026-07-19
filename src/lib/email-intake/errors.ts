import type {
  IntegrationCorrelationId,
  IntegrationOperation,
  IntegrationProvider,
} from "../integrations/contracts";
import { IntegrationBoundaryError } from "../integrations/errors";
import type { EmailIntakeStatus } from "./schemas";

type ErrorContext = {
  correlationId: IntegrationCorrelationId;
  provider?: IntegrationProvider;
  operation?: IntegrationOperation;
};

type StatusTransitionContext = ErrorContext & {
  sourceStatus: EmailIntakeStatus;
  targetStatus: EmailIntakeStatus;
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
  readonly sourceStatus: EmailIntakeStatus;
  readonly targetStatus: EmailIntakeStatus;

  constructor(context: StatusTransitionContext) {
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
    this.sourceStatus = context.sourceStatus;
    this.targetStatus = context.targetStatus;
    Object.defineProperties(this, {
      sourceStatus: { enumerable: false },
      targetStatus: { enumerable: false },
    });
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
