export * from "./contracts";
export { IntakeCoreError, intakeErrorFromUnknown, serializeIntakeError } from "./errors";
export { hashExternalIdentity, maskExternalIdentity, maskedIdentityFromHash } from "./identity";
export { mapEmailIntakeToUnifiedCommand } from "./email-compatibility";
export { assertConversationTransition, statusAfterOrdinaryMessage, transitionConversation } from "./conversation";
export { IntakeCoreService } from "./service";
export type { IntakeCoreRepository, PageResult } from "./repository";
export {
  acceptInboundEventSchema, attachmentInputSchema, canonicalTimestampSchema, enqueueOutboxInputSchema,
  identityBindingInputSchema, intakeLimits, listQuerySchema, revokeBindingInputSchema,
  sessionStateSchema, sessionTransitionInputSchema, sha256Schema,
} from "./schemas";
