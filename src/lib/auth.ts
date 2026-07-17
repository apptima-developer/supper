import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getSessionSecret } from "./env";
import { userRepository } from "./repositories";
import { roleSchema } from "./types";
import { sessionMatchesUser, validLoginUser } from "./auth-policy";

const COOKIE_NAME = "supportdesk_session";

function sessionSecret() {
  return new TextEncoder().encode(getSessionSecret());
}

const sessionSchema = z.object({
  userId: z.string().min(1),
  username: z.string().min(1),
  name: z.string().min(1),
  role: roleSchema,
  authVersion: z.number().int().positive().default(1),
});
export type Session = z.infer<typeof sessionSchema>;

export async function authenticate(username: string, password: string): Promise<Session | null> {
  const users = await userRepository.list();
  const user = users.find((candidate) => candidate.username.toLowerCase() === username.trim().toLowerCase());
  const validUser = await validLoginUser(user, password, bcrypt.compare);
  if (!validUser) return null;
  return {
    userId: validUser.id,
    username: validUser.username,
    name: validUser.name,
    role: validUser.role,
    authVersion: validUser.authVersion,
  };
}

export async function createSession(session: Session) {
  const token = await new SignJWT(session).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("12h").sign(sessionSecret());
  (await cookies()).set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}

export async function clearSession() {
  (await cookies()).delete(COOKIE_NAME);
}

export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionSecret());
    const parsed = sessionSchema.safeParse(payload);
    if (!parsed.success) return null;
    const user = (await userRepository.list()).find((candidate) => candidate.id === parsed.data.userId);
    if (!sessionMatchesUser(parsed.data, user)) return null;
    return {
      userId: user!.id,
      username: user!.username,
      name: user!.name,
      role: user!.role,
      authVersion: user!.authVersion,
    };
  } catch {
    return null;
  }
}

export async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}
