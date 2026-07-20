import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { createClient } from "@supabase/supabase-js";
import { bootstrapAiDevAdmin, resolveAiDevBootstrapConfig } from "./ai-dev-bootstrap-helpers.mjs";

async function main() {
  const config = resolveAiDevBootstrapConfig(process.env);
  const client = createClient(config.url, config.serviceRoleKey, { auth: { persistSession: false } });
  const lookup = async (column, value) => {
    const { data, error } = await client.from("support_users")
      .select("id,username,email,auth_version")
      .eq(column, value)
      .maybeSingle();
    if (error) throw new Error(`Could not inspect support_users: ${error.message}`);
    return data ? { id: data.id, username: data.username, email: data.email, authVersion: data.auth_version || 1 } : undefined;
  };
  const save = async (user, updating) => {
    const row = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      active: user.active,
      auth_version: user.authVersion,
      data: user,
    };
    const query = updating
      ? client.from("support_users").update(row).eq("id", user.id)
      : client.from("support_users").insert(row);
    const { error } = await query;
    if (error) throw new Error(`Could not save AI-development administrator: ${error.message}`);
  };

  const result = await bootstrapAiDevAdmin(config, {
    findByUsername: (username) => lookup("username", username.toLowerCase()),
    findByEmail: (email) => lookup("email", email.toLowerCase()),
    hashPassword: bcrypt.hash,
    createId: crypto.randomUUID,
    createUser: (user) => save(user, false),
    updateUser: (user) => save(user, true),
    log: (event) => console.log(JSON.stringify(event)),
  });
  console.log(`AI-development administrator ${result.action} for project ${result.projectRef}.`);
}

main().catch((error) => {
  console.error(`AI-development bootstrap refused or failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exit(1);
});
