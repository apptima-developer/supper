const supabaseProjectHost = /^(?<ref>[a-z0-9]{20})\.supabase\.co$/;

// The known SUPPER production project must never accept the deliberately weak
// AI-development bootstrap credential. Project refs are public identifiers.
export const knownProductionProjectRefs = Object.freeze(["znzsuxypbrvrdarjkcum"]);

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function parseSupabaseProjectRef(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be a valid URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be a credential-free Supabase HTTPS project origin");
  }
  const match = url.hostname.match(supabaseProjectHost);
  if (!match?.groups?.ref) throw new Error("NEXT_PUBLIC_SUPABASE_URL must be a Supabase project URL");
  return match.groups.ref;
}

export function resolveAiDevBootstrapConfig(env, options = {}) {
  if (env.APP_ENV !== "ai-development") throw new Error("APP_ENV must be exactly ai-development");
  if (env.ALLOW_INSECURE_DEV_BOOTSTRAP !== "true") throw new Error("ALLOW_INSECURE_DEV_BOOTSTRAP must be exactly true");
  if (env.DATA_BACKEND !== "supabase-relational") throw new Error("DATA_BACKEND must be exactly supabase-relational");
  if (env.VERCEL_ENV === "production") throw new Error("AI-development bootstrap is forbidden in Vercel production");

  const url = required(env, "NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = required(env, "SUPABASE_SERVICE_ROLE_KEY");
  const projectRef = parseSupabaseProjectRef(url);
  const targetProjectRef = required(env, "DEV_BOOTSTRAP_TARGET_PROJECT_REF").toLowerCase();
  if (projectRef !== targetProjectRef) throw new Error("Supabase project ref does not match DEV_BOOTSTRAP_TARGET_PROJECT_REF");

  const denied = new Set([...(options.knownProductionRefs || knownProductionProjectRefs), env.PRODUCTION_SUPABASE_PROJECT_REF]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase()));
  if (denied.has(projectRef) || /prod(?:uction)?/.test(projectRef) || /prod(?:uction)?/.test(targetProjectRef)) {
    throw new Error("Bootstrap target is a known or inferred production project");
  }

  const username = required(env, "DEV_BOOTSTRAP_ADMIN_USERNAME");
  if (username !== "admin") throw new Error("DEV_BOOTSTRAP_ADMIN_USERNAME must be exactly admin");
  return Object.freeze({
    url,
    serviceRoleKey,
    projectRef,
    username,
    password: required(env, "DEV_BOOTSTRAP_ADMIN_PASSWORD"),
    email: required(env, "DEV_BOOTSTRAP_ADMIN_EMAIL").toLowerCase(),
    name: "AI Development Admin",
    role: "admin",
    active: true,
  });
}

export async function bootstrapAiDevAdmin(config, dependencies) {
  const existing = await dependencies.findByUsername(config.username);
  const emailOwner = await dependencies.findByEmail(config.email);
  if (emailOwner && emailOwner.id !== existing?.id) throw new Error("Bootstrap email is already assigned to another user");

  const passwordHash = await dependencies.hashPassword(config.password, 10);
  const user = Object.freeze({
    id: existing?.id || dependencies.createId(),
    username: config.username,
    name: config.name,
    email: config.email,
    passwordHash,
    role: config.role,
    active: config.active,
    authVersion: existing ? Math.max(1, existing.authVersion || 1) + 1 : 1,
  });
  if (existing) await dependencies.updateUser(user);
  else await dependencies.createUser(user);
  dependencies.log({ projectRef: config.projectRef, action: existing ? "updated" : "created", username: user.username, role: user.role });
  return Object.freeze({ projectRef: config.projectRef, action: existing ? "updated" : "created", username: user.username, role: user.role, id: user.id, authVersion: user.authVersion });
}
