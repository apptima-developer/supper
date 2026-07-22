import type { ConversationStatus } from "./contracts";
import { IntakeCoreError } from "./errors";
import { canonicalTimestampSchema, correlationIdSchema, intakeIdentifierSchema } from "./schemas";

const ordinaryTransitions: Readonly<Record<ConversationStatus, readonly ConversationStatus[]>> = Object.freeze({
  open: ["awaiting_customer", "awaiting_agent", "linked", "closed"],
  awaiting_customer: ["open", "awaiting_agent", "linked", "closed"],
  awaiting_agent: ["open", "awaiting_customer", "linked", "closed"],
  linked: ["open", "awaiting_customer", "awaiting_agent", "closed"],
  closed: ["archived"],
  archived: [],
});

export function assertConversationTransition(from: ConversationStatus, to: ConversationStatus, explicitReopen = false) {
  if (from === to) return;
  if (from === "closed" && to === "open" && explicitReopen) return;
  if (!ordinaryTransitions[from].includes(to)) {
    throw new IntakeCoreError("INTAKE_VALIDATION_FAILED", "Conversation status transition is not allowed", 409);
  }
}

export function statusAfterOrdinaryMessage(status: ConversationStatus, direction: "inbound" | "outbound" | "internal") {
  if (status === "archived" || status === "closed") return status;
  if (direction === "inbound") return "awaiting_agent" as const;
  if (direction === "outbound") return "awaiting_customer" as const;
  return status;
}

export function transitionConversation(input: {
  status: ConversationStatus;
  version: number;
  expectedVersion: number;
  targetStatus: ConversationStatus;
  explicitReopen?: boolean;
  actorUserId: string;
  correlationId: string;
  occurredAt: string;
}) {
  if (!Number.isInteger(input.version) || input.version < 1 || input.expectedVersion !== input.version) {
    throw new IntakeCoreError("INTAKE_CONVERSATION_VERSION_CONFLICT", "Conversation version conflict", 409);
  }
  assertConversationTransition(input.status, input.targetStatus, input.explicitReopen);
  if (!intakeIdentifierSchema("actorUserId").safeParse(input.actorUserId).success
    || !correlationIdSchema.safeParse(input.correlationId).success
    || !canonicalTimestampSchema.safeParse(input.occurredAt).success) {
    throw new IntakeCoreError("INTAKE_VALIDATION_FAILED", "Conversation transition context is invalid", 400);
  }
  const history = Object.freeze({
    fromStatus: input.status,
    toStatus: input.targetStatus,
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
    occurredAt: input.occurredAt,
    fromVersion: input.version,
    toVersion: input.version + 1,
  });
  return Object.freeze({ status: input.targetStatus, version: input.version + 1, history });
}
