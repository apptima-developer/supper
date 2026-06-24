import type { Role } from "./types";

export type Permission =
  | "customers:view" | "customers:manage" | "customers:ae"
  | "tickets:view" | "tickets:manage" | "tickets:assigned"
  | "imports:manage" | "reports:view" | "reports:manage"
  | "master:manage" | "accounts:manage" | "settings:manage" | "audit:view";

const permissions: Record<Role, Permission[]> = {
  admin: ["customers:view", "customers:manage", "customers:ae", "tickets:view", "tickets:manage", "tickets:assigned", "imports:manage", "reports:view", "reports:manage", "master:manage", "accounts:manage", "settings:manage", "audit:view"],
  lead: ["customers:view", "customers:manage", "customers:ae", "tickets:view", "tickets:manage", "tickets:assigned", "imports:manage", "reports:view", "reports:manage", "master:manage", "audit:view"],
  support: ["customers:view", "tickets:view", "tickets:manage", "tickets:assigned", "reports:view"],
  sales: ["customers:view", "customers:ae", "tickets:view", "reports:view"],
};

export function can(role: Role, permission: Permission) {
  return permissions[role].includes(permission);
}

export function assertCan(role: Role, permission: Permission) {
  if (!can(role, permission)) throw new Error("You do not have permission to perform this action");
}
