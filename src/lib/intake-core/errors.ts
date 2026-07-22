export type IntakeErrorCode =
  | "INTAKE_VALIDATION_FAILED"
  | "INTAKE_RELATIONAL_BACKEND_REQUIRED"
  | "INTAKE_NOT_FOUND"
  | "INTAKE_CONVERSATION_VERSION_CONFLICT"
  | "INTAKE_EVENT_REPLAY_MISMATCH"
  | "INTAKE_MESSAGE_REPLAY_MISMATCH"
  | "INTAKE_IDENTITY_BINDING_INVALID"
  | "INTAKE_SESSION_VERSION_CONFLICT"
  | "INTAKE_SESSION_TRANSITION_INVALID"
  | "INTEGRATION_OUTBOX_IDEMPOTENCY_CONFLICT"
  | "INTAKE_STORAGE_ERROR";

export class IntakeCoreError extends Error {
  readonly code: IntakeErrorCode;
  readonly status: number;

  constructor(code: IntakeErrorCode, safeMessage: string, status = 400, options?: { cause?: unknown }) {
    super(safeMessage, options);
    this.name = "IntakeCoreError";
    this.code = code;
    this.status = status;
  }
}

export function intakeErrorFromUnknown(error: unknown) {
  if (error instanceof IntakeCoreError) return error;
  const message = error instanceof Error ? error.message : "";
  const known = [
    "INTAKE_EVENT_REPLAY_MISMATCH", "INTAKE_MESSAGE_REPLAY_MISMATCH",
    "INTAKE_CONVERSATION_VERSION_CONFLICT",
    "INTAKE_SESSION_VERSION_CONFLICT", "INTAKE_SESSION_TRANSITION_INVALID",
    "INTEGRATION_OUTBOX_IDEMPOTENCY_CONFLICT", "INTAKE_IDENTITY_BINDING_INVALID",
  ] as const;
  const code = known.find((candidate) => message.includes(candidate));
  if (code) return new IntakeCoreError(code, code.replaceAll("_", " ").toLowerCase(), 409, { cause: error });
  return new IntakeCoreError("INTAKE_STORAGE_ERROR", "Unified intake storage operation failed", 500, { cause: error });
}

export function serializeIntakeError(error: unknown) {
  const safe = intakeErrorFromUnknown(error);
  return { error: safe.message, code: safe.code };
}
