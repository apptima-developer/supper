export type BootstrapEnvironment = Record<string, string | undefined>;
export type BootstrapConfig = Readonly<{
  url: string; serviceRoleKey: string; projectRef: string; username: string; password: string;
  email: string; name: "AI Development Admin"; role: "admin"; active: true;
}>;
export const knownProductionProjectRefs: readonly string[];
export function parseSupabaseProjectRef(value: string): string;
export function resolveAiDevBootstrapConfig(env: BootstrapEnvironment, options?: { knownProductionRefs?: string[] }): BootstrapConfig;
export type BootstrapUser = { id: string; username: string; name?: string; email: string; passwordHash?: string; role?: string; active?: boolean; authVersion: number };
export type BootstrapDependencies = {
  findByUsername(username: string): Promise<BootstrapUser | undefined>;
  findByEmail(email: string): Promise<BootstrapUser | undefined>;
  hashPassword(password: string, cost: number): Promise<string>;
  createId(): string;
  createUser(user: BootstrapUser): Promise<unknown>;
  updateUser(user: BootstrapUser): Promise<unknown>;
  log(event: Record<string, string>): void;
};
export function bootstrapAiDevAdmin(config: BootstrapConfig, dependencies: BootstrapDependencies): Promise<Readonly<Record<string, string | number>>>;
