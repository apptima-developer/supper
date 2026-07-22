import { describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth";
import { handleIntakeDiagnosticPost, intakeDiagnosticAllowed } from "./diagnostic-api";
import type { IntakeCoreRepository } from "./repository";
import { IntakeCoreService } from "./service";

const admin: Session = { userId: "admin", username: "admin", name: "Admin", role: "admin", authVersion: 1 };

function fakeRepository() {
  let deliveries = 0;
  const repository = {
    ensureDiagnosticChannel: vi.fn(async () => undefined),
    acceptInboundEvent: vi.fn(async () => {
      deliveries += 1;
      return { action: deliveries === 1 ? "accepted" : "duplicate", event_id: "event-1", identity_id: "identity-1", conversation_id: "conversation-1", message_id: "message-1", attachment_count: 1, session_id: "session-1", delivery_count: deliveries };
    }),
    listConversationMessages: vi.fn(async () => ({ items: [{ messageId: "message-1" }], total: 1, page: 1, limit: 100, hasNext: false })),
    listConversationAttachments: vi.fn(async () => ({ items: [{ attachmentId: "attachment-1" }], total: 1, page: 1, limit: 100, hasNext: false })),
    findSession: vi.fn(async () => ({ status: "collecting" })),
  } as unknown as IntakeCoreRepository;
  return { repository, service: new IntakeCoreService(repository, () => "supabase-relational") };
}

describe("AI-development intake diagnostic", () => {
  it("is hidden outside the exact non-production relational guard", () => {
    expect(intakeDiagnosticAllowed({ APP_ENV: "ai-development", VERCEL_ENV: "preview" }, "supabase-relational")).toBe(true);
    expect(intakeDiagnosticAllowed({ APP_ENV: "ai-development", VERCEL_ENV: "production" }, "supabase-relational")).toBe(false);
    expect(intakeDiagnosticAllowed({ APP_ENV: "production", VERCEL_ENV: "preview" }, "supabase-relational")).toBe(false);
    expect(intakeDiagnosticAllowed({ APP_ENV: "ai-development", VERCEL_ENV: "preview" }, "supabase")).toBe(false);
  });

  it("returns 404 before ingestion when guard or permission fails", async () => {
    const fake = fakeRepository();
    const response = await handleIntakeDiagnosticPost(new Request("https://app.test/api/integrations/intake/diagnostic-sample", { method: "POST" }), { getSession: async () => admin, getBackend: () => "supabase-relational", env: { APP_ENV: "production", VERCEL_ENV: "preview" }, ...fake });
    expect(response.status).toBe(404);
    expect(fake.repository.acceptInboundEvent).not.toHaveBeenCalled();
  });

  it("accepts then replays through the same service without a network call", async () => {
    const fake = fakeRepository();
    const network = vi.spyOn(globalThis, "fetch");
    const response = await handleIntakeDiagnosticPost(new Request("https://app.test/api/integrations/intake/diagnostic-sample", { method: "POST" }), { getSession: async () => admin, getBackend: () => "supabase-relational", env: { APP_ENV: "ai_development", VERCEL_ENV: "preview" }, ...fake });
    const body = await response.json();
    expect(response.status).toBe(200); expect(body.firstAction).toBe("accepted"); expect(body.replayAction).toBe("duplicate");
    expect(body.messageCount).toBe(1); expect(body.attachmentMetadataCount).toBe(1); expect(body.sessionStatus).toBe("collecting");
    expect(fake.repository.acceptInboundEvent).toHaveBeenCalledTimes(2); expect(network).not.toHaveBeenCalled();
    network.mockRestore();
  });
});
