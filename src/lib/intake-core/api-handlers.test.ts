import { describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth";
import { handleIntakeChannelsGet, handleIntakeConversationDetailGet, handleIntakeIdentitiesGet, handleIntakeOutboxGet } from "./api-handlers";

const admin: Session = { userId: "admin", username: "admin", name: "Admin", role: "admin", authVersion: 1 };
const support: Session = { userId: "support", username: "support", name: "Support", role: "support", authVersion: 1 };

function dependencies(session: Session | null) {
  const service = {
    channels: vi.fn(async () => ({ items: [], total: 0, page: 1, limit: 25, hasNext: false })),
    identities: vi.fn(async () => ({ items: [{ identityId: "identity-1", maskedExternalIdentity: "Uabc••••9xyz" }], total: 1, page: 1, limit: 25, hasNext: false })),
    outbox: vi.fn(async () => ({ items: [{ commandId: "command-1", status: "pending" }], total: 1, page: 1, limit: 25, hasNext: false })),
    conversation: vi.fn(async () => ({ conversationId: "conversation-1" })),
    messages: vi.fn(async () => ({ items: [{ messageId: "message-1", textPreview: "safe" }], total: 1, page: 1, limit: 25, hasNext: false })),
    attachments: vi.fn(async () => ({ items: [{ attachmentId: "attachment-1", fileName: "safe.txt" }], total: 1, page: 1, limit: 25, hasNext: false })),
  };
  return { getSession: vi.fn(async () => session), service: service as never, repository: {} as never, mocks: service };
}

describe("unified intake read API boundary", () => {
  it("requires authentication and settings permission", async () => {
    expect((await handleIntakeChannelsGet(new Request("https://app.test/api/integrations/intake/channels"), dependencies(null))).status).toBe(401);
    expect((await handleIntakeChannelsGet(new Request("https://app.test/api/integrations/intake/channels"), dependencies(support))).status).toBe(403);
  });

  it("keeps pagination bounded and returns masked identity presentation only", async () => {
    const invalid = await handleIntakeIdentitiesGet(new Request("https://app.test/api/integrations/intake/identities?limit=101"), dependencies(admin));
    expect(invalid.status).toBe(400);
    const valid = await handleIntakeIdentitiesGet(new Request("https://app.test/api/integrations/intake/identities?limit=25"), dependencies(admin));
    const body = await valid.json();
    expect(body.items[0].maskedExternalIdentity).toContain("••••");
    expect(JSON.stringify(body)).not.toContain("external_subject_id");
  });

  it("returns sanitized conversation detail without HTML or provider locator", async () => {
    const response = await handleIntakeConversationDetailGet(new Request("https://app.test/api/integrations/intake/conversations/conversation-1"), "conversation-1", dependencies(admin));
    const body = await response.json();
    expect(body.messages.items[0]).toEqual({ messageId: "message-1", textPreview: "safe" });
    expect(JSON.stringify(body)).not.toMatch(/bodyHtml|providerLocator|storageObjectKey/i);
    expect(JSON.stringify(body)).not.toMatch(/targetReferences|callerId|companyId/i);
  });

  it("independently bounds Message and Attachment detail pages", async () => {
    const invalidMessages = await handleIntakeConversationDetailGet(
      new Request("https://app.test/api/integrations/intake/conversations/conversation-1?messageLimit=101"),
      "conversation-1",
      dependencies(admin),
    );
    expect(invalidMessages.status).toBe(400);
    const invalidAttachments = await handleIntakeConversationDetailGet(
      new Request("https://app.test/api/integrations/intake/conversations/conversation-1?attachmentLimit=101"),
      "conversation-1",
      dependencies(admin),
    );
    expect(invalidAttachments.status).toBe(400);
  });

  it("keeps outbox API read-only and omits payload", async () => {
    const response = await handleIntakeOutboxGet(new Request("https://app.test/api/integrations/intake/outbox"), dependencies(admin));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain("payload");
  });

  it("accepts integration-wide Outbox providers but keeps Channel providers ordinary", async () => {
    for (const provider of ["servicenow", "freshservice"]) {
      const context = dependencies(admin);
      const response = await handleIntakeOutboxGet(new Request(`https://app.test/api/integrations/intake/outbox?provider=${provider}`), context);
      expect(response.status).toBe(200);
      expect(context.mocks.outbox).toHaveBeenCalledWith(expect.objectContaining({ provider }));
    }
    const invalidChannel = await handleIntakeChannelsGet(
      new Request("https://app.test/api/integrations/intake/channels?provider=freshservice"),
      dependencies(admin),
    );
    expect(invalidChannel.status).toBe(400);
  });

  it("returns the bounded intake not-found code for a missing conversation", async () => {
    const context = dependencies(admin);
    context.mocks.conversation.mockResolvedValueOnce(undefined as never);
    const response = await handleIntakeConversationDetailGet(
      new Request("https://app.test/api/integrations/intake/conversations/missing"),
      "missing",
      context,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "INTAKE_CONVERSATION_NOT_FOUND" });
  });
});
