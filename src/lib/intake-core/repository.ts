import type {
  AcceptInboundEvent, AcceptInboundEventResult, EnqueueOutboxInput, IdentityBindingInput,
  ListQuery, RevokeBindingInput, SessionTransitionInput,
} from "./schemas";
import type { IntakeOperationsSummary } from "./presentation";

export type PageResult<T> = { items: T[]; total: number; page: number; limit: number };

export interface IntakeCoreRepository {
  getOperationsSummary(): Promise<IntakeOperationsSummary>;
  listChannels(query: ListQuery): Promise<PageResult<Record<string, unknown>>>;
  findChannel(id: string): Promise<Record<string, unknown> | undefined>;
  listIdentities(query: ListQuery): Promise<PageResult<Record<string, unknown>>>;
  findIdentity(id: string): Promise<Record<string, unknown> | undefined>;
  listConversations(query: ListQuery): Promise<PageResult<Record<string, unknown>>>;
  findConversation(id: string): Promise<Record<string, unknown> | undefined>;
  listConversationMessages(conversationId: string): Promise<Record<string, unknown>[]>;
  listConversationAttachments(conversationId: string): Promise<Record<string, unknown>[]>;
  listSessions(query: ListQuery): Promise<PageResult<Record<string, unknown>>>;
  findSession(id: string): Promise<Record<string, unknown> | undefined>;
  listInboundEvents(query: ListQuery): Promise<PageResult<Record<string, unknown>>>;
  listOutboxCommands(query: ListQuery): Promise<PageResult<Record<string, unknown>>>;
  acceptInboundEvent(input: AcceptInboundEvent): Promise<AcceptInboundEventResult>;
  applyIdentityBinding(input: IdentityBindingInput): Promise<Record<string, unknown>>;
  revokeIdentityBinding(input: RevokeBindingInput): Promise<Record<string, unknown>>;
  transitionSession(input: SessionTransitionInput): Promise<Record<string, unknown>>;
  enqueueOutbox(input: EnqueueOutboxInput): Promise<Record<string, unknown>>;
  linkConversationTicket(input: { id: string; conversationId: string; ticketId: string; relationship: "primary" | "related" | "duplicate" | "follow_up"; actorUserId?: string; correlationId?: string; metadata?: Record<string, unknown> }): Promise<void>;
  ensureDiagnosticChannel(input: { id: string; channelKey: string; displayName: string; now: string; actorUserId: string }): Promise<void>;
}
