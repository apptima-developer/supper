import type { Session } from "./auth";
import type { User } from "./types";

export const genericAuthenticationFailure = "Authentication failed";
export const dummyPasswordHash = "$2b$10$hvA0tmqoeiddX5oOi/UBqeCTEFmsh02QROXxkoQ7bLN0a1Z5XmtlK";

export function sessionMatchesUser(session: Session, user: User | undefined) {
  return Boolean(user && user.active && user.authVersion === session.authVersion);
}

export async function validLoginUser(
  user: User | undefined,
  password: string,
  compare: (password: string, hash: string) => Promise<boolean>,
) {
  const passwordMatches = await compare(password, user?.passwordHash || dummyPasswordHash);
  return user && user.active && passwordMatches ? user : null;
}
