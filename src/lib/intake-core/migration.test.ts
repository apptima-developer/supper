import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(path.join(process.cwd(), "supabase/migrations/202607220001_unified_intake_core.sql"), "utf8");
const correctionSql = readFileSync(path.join(process.cwd(), "supabase/migrations/202607220002_unified_intake_core_corrections.sql"), "utf8");
const replaySql = readFileSync(path.join(process.cwd(), "supabase/migrations/202607220003_unified_intake_core_replay_corrections.sql"), "utf8");
const finalIntegritySql = readFileSync(path.join(process.cwd(), "supabase/migrations/202607220004_unified_intake_core_final_integrity.sql"), "utf8");
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

  it("keeps the immutable correction migration scoped, idempotent, and service-role-only", () => {
    for (const table of ["intake_conversation_events", "intake_session_events"]) {
      expect(correctionSql).toContain(`create table if not exists public.${table}`);
      expect(correctionSql).toContain(`alter table public.${table} enable row level security`);
      expect(correctionSql).toMatch(new RegExp(`revoke all privileges on table[\\s\\S]*?public\\.${table}[^;]*from public, anon, authenticated`));
    }
    for (const name of [
      "support_list_intake_identities",
      "support_list_intake_conversations",
      "support_list_intake_events",
      "support_transition_intake_conversation",
    ]) {
      expect(correctionSql).toContain(`function public.${name}`);
      expect(correctionSql).toContain(`grant execute on function public.${name}`);
    }
    expect(correctionSql).toContain("'202607220002'");
    expect(correctionSql).not.toMatch(/drop\s+table|truncate\s+|delete\s+from\s+public\.support_/i);
  });

  it("enforces canonical replay, durable history, scoped locking, and accepted redelivery semantics", () => {
    for (const code of [
      "INTAKE_EVENT_REPLAY_MISMATCH",
      "INTAKE_MESSAGE_REPLAY_MISMATCH",
      "INTAKE_ATTACHMENT_REPLAY_MISMATCH",
      "INTAKE_CONVERSATION_VERSION_CONFLICT",
    ]) expect(correctionSql).toContain(code);
    for (const scope of ["intake-event:", "intake-message:", "intake-conversation:", "intake-identity:"]) {
      expect(correctionSql).toContain(scope);
    }
    expect(correctionSql).toContain("duplicate_delivery_count = event_record.duplicate_delivery_count + 1");
    expect(correctionSql).not.toMatch(/integration_channels[^;]{0,500}for update/i);
    expect(correctionSql).toContain("insert into public.intake_conversation_events");
    expect(correctionSql).toContain("insert into public.intake_session_events");
  });

  it("validates recursive JSON policy and casts through bounded helpers", () => {
    expect(correctionSql).toContain("support_intake_json_has_unsafe_key");
    expect(correctionSql).toContain("support_intake_json_keys_allowed");
    expect(correctionSql).toContain("support_intake_parse_timestamp");
    expect(correctionSql).toContain("support_intake_parse_integer");
    expect(correctionSql).toContain("support_intake_parse_bigint");
    expect(correctionSql).not.toMatch(/:=\s*\(p_payload[^;]+\)::(?:timestamp|timestamptz|integer|bigint)/i);
  });

  it("adds final forward-only replay, hash, delivery, and global-lock integrity", () => {
    expect(replaySql).toContain("'202607220003'");
    expect(finalIntegritySql).toContain("'202607220004'");
    for (const code of [
      "INTAKE_ATTACHMENT_DUPLICATE_IN_EVENT",
      "INTAKE_ATTACHMENT_REPLAY_MISMATCH",
      "INTAKE_STORAGE_INTEGRITY_ERROR",
    ]) expect(finalIntegritySql).toContain(code);
    for (const scope of ["intake-event:", "intake-message:", "intake-conversation:", "intake-identity:", "intake-attachment:"]) {
      expect(finalIntegritySql).toContain(scope);
    }
    expect(finalIntegritySql).toContain("support_accept_intake_event_final_impl");
    expect(finalIntegritySql).toContain("support_accept_intake_event_locked_write_impl");
    expect(finalIntegritySql).toContain("support_accept_intake_event_v3");
    expect(finalIntegritySql).toContain("support_intake_persisted_message_material");
    expect(finalIntegritySql).toContain("request_id, correlation_id, metadata");
    expect(finalIntegritySql).not.toMatch(/drop\s+table|truncate\s+|delete\s+from\s+public\.support_/i);
  });
});
