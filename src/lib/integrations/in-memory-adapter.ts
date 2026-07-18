import type {
  IntegrationConnector,
  IntegrationInvocationContext,
  IntegrationInvocationRecord,
  IntegrationOperation,
  IntegrationProvider,
  IntegrationResult,
} from "./contracts";
import { IntegrationBoundaryError } from "./errors";
import { correlationIdSchema, idempotencyKeySchema, integrationBoundaryLimits } from "./schemas";

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

export class InMemoryIntegrationConnector<Input, Output> implements IntegrationConnector<Input, Output> {
  readonly provider: IntegrationProvider;
  readonly operation: IntegrationOperation;
  readonly #results: IntegrationResult<Output>[];
  readonly #invocations: IntegrationInvocationRecord[] = [];
  #cursor = 0;

  constructor(options: {
    provider: IntegrationProvider;
    operation: IntegrationOperation;
    results: IntegrationResult<Output>[];
  }) {
    if (options.results.length === 0) throw new TypeError("At least one predefined result is required");
    this.provider = options.provider;
    this.operation = options.operation;
    this.#results = clone(options.results);
  }

  get invocations(): readonly IntegrationInvocationRecord[] {
    return clone(this.#invocations);
  }

  async execute(_input: Input, context: IntegrationInvocationContext): Promise<IntegrationResult<Output>> {
    const correlationId = correlationIdSchema.parse(context.correlationId);
    const idempotencyKey = idempotencyKeySchema.parse(context.idempotencyKey);
    if (!Number.isInteger(context.attempt) || context.attempt < 1 || context.attempt > integrationBoundaryLimits.retryAttempts) {
      throw new TypeError("Integration invocation attempt is invalid");
    }
    const aborted = context.signal?.aborted === true;
    this.#invocations.push({
      provider: this.provider,
      operation: this.operation,
      correlationId,
      idempotencyKey,
      attempt: context.attempt,
      aborted,
    });

    if (aborted) {
      return {
        ok: false,
        error: new IntegrationBoundaryError({
          category: "timeout",
          code: "OPERATION_ABORTED",
          safeMessage: "The integration operation was aborted",
          retryable: true,
          provider: this.provider,
          operation: this.operation,
          correlationId,
        }).toPublic(),
      };
    }

    const index = Math.min(this.#cursor, this.#results.length - 1);
    this.#cursor += 1;
    return clone(this.#results[index]);
  }
}
