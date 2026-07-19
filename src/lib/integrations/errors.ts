import { isValidRequestId } from "../request-id";
import {
  integrationErrorCategories,
  integrationOperations,
  integrationProviders,
  type IntegrationCorrelationId,
  type IntegrationErrorCategory,
  type IntegrationFailure,
  type IntegrationOperation,
  type IntegrationProvider,
} from "./contracts";
import { containsControlCharacters } from "./validation";

type IntegrationBoundaryErrorOptions = {
  category: IntegrationErrorCategory;
  code: string;
  safeMessage: string;
  retryable: boolean;
  provider: IntegrationProvider;
  operation: IntegrationOperation;
  correlationId: IntegrationCorrelationId;
  cause?: unknown;
};

function normalizeCode(value: string) {
  const code = value.trim();
  if (!/^[A-Z0-9_]{1,80}$/.test(code)) throw new TypeError("Integration error code is invalid");
  return code;
}

function normalizeSafeMessage(value: string) {
  const message = value.trim();
  if (!message || message.length > 240 || containsControlCharacters(message)) {
    throw new TypeError("Integration safe message is invalid");
  }
  return message;
}

export class IntegrationBoundaryError extends Error {
  readonly category: IntegrationErrorCategory;
  readonly code: string;
  readonly safeMessage: string;
  readonly retryable: boolean;
  readonly provider: IntegrationProvider;
  readonly operation: IntegrationOperation;
  readonly correlationId: IntegrationCorrelationId;

  constructor(options: IntegrationBoundaryErrorOptions) {
    if (!integrationErrorCategories.includes(options.category)) throw new TypeError("Integration error category is invalid");
    if (!integrationProviders.includes(options.provider)) throw new TypeError("Integration error provider is invalid");
    if (!integrationOperations.includes(options.operation)) throw new TypeError("Integration error operation is invalid");
    if (!isValidRequestId(options.correlationId)) throw new TypeError("Integration error correlation ID is invalid");
    super(normalizeSafeMessage(options.safeMessage));
    this.name = "IntegrationBoundaryError";
    this.category = options.category;
    this.code = normalizeCode(options.code);
    this.safeMessage = this.message;
    this.retryable = options.retryable;
    this.provider = options.provider;
    this.operation = options.operation;
    this.correlationId = options.correlationId;
    for (const key of ["name", "category", "code", "safeMessage", "retryable", "provider", "operation", "correlationId"]) {
      Object.defineProperty(this, key, { enumerable: false });
    }
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", { value: options.cause, enumerable: false, configurable: false });
    }
  }

  toPublic(): IntegrationFailure {
    return {
      category: this.category,
      code: this.code,
      safeMessage: this.safeMessage,
      retryable: this.retryable,
      provider: this.provider,
      operation: this.operation,
      correlationId: this.correlationId,
    };
  }

  toLog() {
    return {
      errorType: this.name,
      ...this.toPublic(),
    };
  }
}

export function isIntegrationBoundaryError(value: unknown): value is IntegrationBoundaryError {
  return value instanceof IntegrationBoundaryError;
}

export function normalizeIntegrationError(
  value: unknown,
  fallback: Omit<IntegrationBoundaryErrorOptions, "cause">,
) {
  if (isIntegrationBoundaryError(value)) return value;
  return new IntegrationBoundaryError({ ...fallback, cause: value });
}

export function serializeIntegrationErrorForPublic(value: IntegrationBoundaryError) {
  return value.toPublic();
}

export function serializeIntegrationErrorForLog(value: IntegrationBoundaryError) {
  return value.toLog();
}
