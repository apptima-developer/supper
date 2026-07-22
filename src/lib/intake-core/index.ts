export * from "./contracts";
export { IntakeCoreError, intakeErrorFromUnknown, serializeIntakeError } from "./errors";
export { hashExternalIdentity, maskExternalIdentity, maskedIdentityFromHash } from "./identity";
export { mapEmailIntakeToUnifiedCommand } from "./email-compatibility";
export { assertConversationTransition, statusAfterOrdinaryMessage, transitionConversation } from "./conversation";
export { IntakeCoreService } from "./service";
export type { IntakeCoreRepository, PageResult } from "./repository";
export {
  acceptInboundEventInputSchema, acceptInboundEventSchema, attachmentInputSchema, canonicalTimestampSchema,
  conversationAttachmentListQuerySchema, conversationListQuerySchema, conversationMessageListQuerySchema,
  conversationTransitionInputSchema, enqueueOutboxInputSchema, eventListQuerySchema,
  identityBindingInputSchema, identityListQuerySchema, intakeChannelListQuerySchema, intakeLimits,
  outboxListQuerySchema, revokeBindingInputSchema, sessionStateSchema, sessionTransitionInputSchema, sha256Schema,
} from "./schemas";
export {
  canonicalIntakeAttachmentMaterial, canonicalIntakeAttachmentSourceHash, canonicalIntakeEventMaterial, canonicalIntakeMessageMaterial,
  canonicalSerializeIntakeMaterial, hashCanonicalIntakeMaterial, prepareCanonicalIntakeEvent,
} from "./canonical-material";
export { assertCanonicalIntakeNumbers, MAX_CANONICAL_SAFE_INTEGER, MIN_CANONICAL_SAFE_INTEGER } from "./canonical-json";
export { assertNoSensitiveIntakeData, classifyIntakeJsonKey, findUnsafeIntakeJsonKey, normalizeIntakeJsonKey } from "./sensitive-data";
