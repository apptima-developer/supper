import { getDataBackend } from "@/lib/env";
import type { DataBackend } from "@/lib/env";
import { IntakeCoreError } from "./errors";
import type { IntakeCoreRepository } from "./repository";
import {
  acceptInboundEventSchema, enqueueOutboxInputSchema, identityBindingInputSchema,
  listQuerySchema, revokeBindingInputSchema, sessionTransitionInputSchema,
} from "./schemas";

export class IntakeCoreService {
  constructor(private readonly repository: IntakeCoreRepository, private readonly backend: () => DataBackend = getDataBackend) {}

  private requireRelational() {
    if (this.backend() !== "supabase-relational") {
      throw new IntakeCoreError("INTAKE_RELATIONAL_BACKEND_REQUIRED", "Unified intake writes require the relational data backend", 503);
    }
  }

  operations() { return this.repository.getOperationsSummary(); }
  channels(query: unknown) { return this.repository.listChannels(listQuerySchema.parse(query)); }
  identities(query: unknown) { return this.repository.listIdentities(listQuerySchema.parse(query)); }
  conversations(query: unknown) { return this.repository.listConversations(listQuerySchema.parse(query)); }
  sessions(query: unknown) { return this.repository.listSessions(listQuerySchema.parse(query)); }
  events(query: unknown) { return this.repository.listInboundEvents(listQuerySchema.parse(query)); }
  outbox(query: unknown) { return this.repository.listOutboxCommands(listQuerySchema.parse(query)); }
  conversation(id: string) { return this.repository.findConversation(id); }
  messages(id: string) { return this.repository.listConversationMessages(id); }
  attachments(id: string) { return this.repository.listConversationAttachments(id); }

  accept(input: unknown) { this.requireRelational(); return this.repository.acceptInboundEvent(acceptInboundEventSchema.parse(input)); }
  bind(input: unknown) { this.requireRelational(); return this.repository.applyIdentityBinding(identityBindingInputSchema.parse(input)); }
  revoke(input: unknown) { this.requireRelational(); return this.repository.revokeIdentityBinding(revokeBindingInputSchema.parse(input)); }
  transition(input: unknown) { this.requireRelational(); return this.repository.transitionSession(sessionTransitionInputSchema.parse(input)); }
  enqueue(input: unknown) { this.requireRelational(); return this.repository.enqueueOutbox(enqueueOutboxInputSchema.parse(input)); }
}
