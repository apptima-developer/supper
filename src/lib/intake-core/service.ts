import type { DataBackend } from "@/lib/env";
import { getDataBackend } from "@/lib/env";
import { prepareCanonicalIntakeEvent } from "./canonical-material";
import { IntakeCoreError } from "./errors";
import type { IntakeCoreRepository } from "./repository";
import {
  conversationAttachmentListQuerySchema,
  conversationListQuerySchema, conversationMessageListQuerySchema, conversationTransitionInputSchema,
  enqueueOutboxInputSchema, eventListQuerySchema, identityBindingInputSchema, identityListQuerySchema,
  intakeChannelListQuerySchema, outboxListQuerySchema, revokeBindingInputSchema, sessionListQuerySchema,
  sessionTransitionInputSchema,
} from "./schemas";

export class IntakeCoreService {
  constructor(private readonly repository: IntakeCoreRepository, private readonly backend: () => DataBackend = getDataBackend) {}

  private requireRelational() {
    if (this.backend() !== "supabase-relational") throw new IntakeCoreError("INTAKE_RELATIONAL_BACKEND_REQUIRED");
  }

  operations() { return this.repository.getOperationsSummary(); }
  channels(query: unknown) { return this.repository.listChannels(intakeChannelListQuerySchema.parse(query)); }
  identities(query: unknown) { return this.repository.listIdentities(identityListQuerySchema.parse(query)); }
  conversations(query: unknown) { return this.repository.listConversations(conversationListQuerySchema.parse(query)); }
  sessions(query: unknown) { return this.repository.listSessions(sessionListQuerySchema.parse(query)); }
  events(query: unknown) { return this.repository.listInboundEvents(eventListQuerySchema.parse(query)); }
  outbox(query: unknown) { return this.repository.listOutboxCommands(outboxListQuerySchema.parse(query)); }
  conversation(id: string) { return this.repository.findConversation(id); }
  messages(id: string, query: unknown) { return this.repository.listConversationMessages(id, conversationMessageListQuerySchema.parse(query)); }
  attachments(id: string, query: unknown) { return this.repository.listConversationAttachments(id, conversationAttachmentListQuerySchema.parse(query)); }

  accept(input: unknown) {
    this.requireRelational();
    try { return this.repository.acceptInboundEvent(prepareCanonicalIntakeEvent(input)); }
    catch (error) {
      if (error instanceof IntakeCoreError) throw error;
      throw new IntakeCoreError("INTAKE_PAYLOAD_INVALID", undefined, undefined, { cause: error });
    }
  }

  bind(input: unknown) { this.requireRelational(); return this.repository.applyIdentityBinding(identityBindingInputSchema.parse(input)); }
  revoke(input: unknown) { this.requireRelational(); return this.repository.revokeIdentityBinding(revokeBindingInputSchema.parse(input)); }
  transitionSession(input: unknown) { this.requireRelational(); return this.repository.transitionSession(sessionTransitionInputSchema.parse(input)); }
  transitionConversation(input: unknown) { this.requireRelational(); return this.repository.transitionConversation(conversationTransitionInputSchema.parse(input)); }
  enqueue(input: unknown) { this.requireRelational(); return this.repository.enqueueOutbox(enqueueOutboxInputSchema.parse(input)); }
}
