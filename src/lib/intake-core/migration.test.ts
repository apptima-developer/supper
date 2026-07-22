import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(path.join(process.cwd(), "supabase/migrations/202607220001_unified_intake_core.sql"), "utf8");
const tables = ["integration_channels", "integration_external_identities", "integration_identity_bindings", "integration_identity_binding_events", "intake_conversations", "intake_messages", "intake_attachments", "intake_sessions", "intake_events", "intake_ticket_links", "integration_outbox"];
const functions = ["support_get_intake_operations_summary", "support_accept_intake_event", "support_apply_intake_identity_binding", "support_revoke_intake_identity_binding", "support_transition_intake_session", "support_enqueue_integration_outbox"];

describe("AI-1.3 migration contract", () => {
  it("creates every normalized table, enables RLS, and records the forward migration", () => {
    for (const table of tables) {
      expect(sql).toContain(`create table if not exists public.${table}`);
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("'202607220001'");
    expect(sql).not.toMatch(/drop\s+table|truncate\s+|delete\s+from\s+public\.support_/i);
  });

  it("locks privileged RPCs to service_role and contains no provider transport", () => {
    for (const name of functions) {
      expect(sql).toContain(`function public.${name}`);
      expect(sql).toContain(`public.${name}`);
    }
    expect(sql).toContain("revoke all privileges on function");
    expect(sql).toContain("revoke execute on function");
    expect(sql).toContain("grant execute on function");
    expect(sql).not.toMatch(/http_post|net\.http|service-now\.com|pg_net|dblink_connect/i);
  });

  it("models replay conflicts, session CAS, attachment metadata, and intent-only outbox", () => {
    for (const code of ["INTAKE_EVENT_REPLAY_MISMATCH", "INTAKE_MESSAGE_REPLAY_MISMATCH", "INTAKE_SESSION_VERSION_CONFLICT", "INTEGRATION_OUTBOX_IDEMPOTENCY_CONFLICT"]) expect(sql).toContain(code);
    expect(sql).toContain("declared_size bigint"); expect(sql).not.toMatch(/bytea|large object/i);
    expect(sql).toContain("status text not null default 'pending'");
  });
});
