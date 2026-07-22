export type IntakeErrorCode =
  | "INTAKE_PAYLOAD_INVALID"
  | "INTAKE_SENSITIVE_DATA_REJECTED"
  | "INTAKE_CANONICAL_NUMBER_INVALID"
  | "INTAKE_TARGET_REFERENCE_INVALID"
  | "INTAKE_CHANNEL_UNAVAILABLE"
  | "INTAKE_IDENTITY_HASH_MISMATCH"
  | "INTAKE_EVENT_REPLAY_MISMATCH"
  | "INTAKE_MESSAGE_REPLAY_MISMATCH"
  | "INTAKE_ATTACHMENT_REPLAY_MISMATCH"
  | "INTAKE_REPLY_MESSAGE_INVALID"
  | "INTAKE_CONVERSATION_NOT_FOUND"
  | "INTAKE_CONVERSATION_VERSION_CONFLICT"
  | "INTAKE_CONVERSATION_TRANSITION_INVALID"
  | "INTAKE_SESSION_NOT_FOUND"
  | "INTAKE_SESSION_VERSION_CONFLICT"
  | "INTAKE_SESSION_TRANSITION_INVALID"
  | "INTAKE_IDENTITY_BINDING_INVALID"
  | "INTEGRATION_OUTBOX_PAYLOAD_INVALID"
  | "INTEGRATION_OUTBOX_IDEMPOTENCY_CONFLICT"
  | "INTAKE_RELATIONAL_BACKEND_REQUIRED"
  | "INTAKE_STORAGE_ERROR";

const errorCatalogue: Readonly<Record<IntakeErrorCode, { status: number; message: string }>> = Object.freeze({
  INTAKE_PAYLOAD_INVALID: { status: 400, message: "Unified intake payload is invalid" },
  INTAKE_SENSITIVE_DATA_REJECTED: { status: 400, message: "Credential-bearing fields are not accepted" },
  INTAKE_CANONICAL_NUMBER_INVALID: { status: 400, message: "Canonical JSON numbers must be safe integers" },
  INTAKE_TARGET_REFERENCE_INVALID: { status: 422, message: "The target reference contract is invalid" },
  INTAKE_CHANNEL_UNAVAILABLE: { status: 422, message: "The intake channel is unavailable" },
  INTAKE_IDENTITY_HASH_MISMATCH: { status: 409, message: "The intake identity material does not match" },
  INTAKE_EVENT_REPLAY_MISMATCH: { status: 409, message: "The event identifier was already used with different material" },
  INTAKE_MESSAGE_REPLAY_MISMATCH: { status: 409, message: "The message identifier was already used with different material" },
  INTAKE_ATTACHMENT_REPLAY_MISMATCH: { status: 409, message: "The attachment identifier was already used with different material" },
  INTAKE_REPLY_MESSAGE_INVALID: { status: 422, message: "The reply target is invalid for this conversation" },
  INTAKE_CONVERSATION_NOT_FOUND: { status: 404, message: "The intake conversation was not found" },
  INTAKE_CONVERSATION_VERSION_CONFLICT: { status: 409, message: "The intake conversation changed before this request completed" },
  INTAKE_CONVERSATION_TRANSITION_INVALID: { status: 409, message: "The requested conversation transition is not allowed" },
  INTAKE_SESSION_NOT_FOUND: { status: 404, message: "The intake session was not found" },
  INTAKE_SESSION_VERSION_CONFLICT: { status: 409, message: "The intake session changed before this request completed" },
  INTAKE_SESSION_TRANSITION_INVALID: { status: 409, message: "The requested session transition is not allowed" },
  INTAKE_IDENTITY_BINDING_INVALID: { status: 422, message: "The requested identity binding is invalid" },
  INTEGRATION_OUTBOX_PAYLOAD_INVALID: { status: 400, message: "The integration command payload is invalid" },
  INTEGRATION_OUTBOX_IDEMPOTENCY_CONFLICT: { status: 409, message: "The command identifier was already used with different material" },
  INTAKE_RELATIONAL_BACKEND_REQUIRED: { status: 503, message: "Unified intake requires the relational data backend" },
  INTAKE_STORAGE_ERROR: { status: 500, message: "Unified intake storage operation failed" },
});

export class IntakeCoreError extends Error {
  readonly code: IntakeErrorCode;
  readonly status: number;

  constructor(code: IntakeErrorCode, safeMessage = errorCatalogue[code].message, status = errorCatalogue[code].status, options?: { cause?: unknown }) {
    super(safeMessage, options);
    this.name = "IntakeCoreError";
    this.code = code;
    this.status = status;
  }
}

export function intakeErrorFromUnknown(error: unknown) {
  if (error instanceof IntakeCoreError) return error;
  const suppliedCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? (Object.keys(errorCatalogue) as IntakeErrorCode[]).find((candidate) => candidate === error.code)
    : undefined;
  if (suppliedCode) return new IntakeCoreError(suppliedCode, errorCatalogue[suppliedCode].message, errorCatalogue[suppliedCode].status, { cause: error });
  const message = error instanceof Error ? error.message : "";
  const code = (Object.keys(errorCatalogue) as IntakeErrorCode[]).find((candidate) => message.includes(candidate));
  if (code) return new IntakeCoreError(code, errorCatalogue[code].message, errorCatalogue[code].status, { cause: error });
  return new IntakeCoreError("INTAKE_STORAGE_ERROR", undefined, undefined, { cause: error });
}

export function serializeIntakeError(error: unknown) {
  const safe = intakeErrorFromUnknown(error);
  return { error: safe.message, code: safe.code };
}
