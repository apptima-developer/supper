import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { userRepository } from "./repositories";
import type { Role } from "./types";

const COOKIE_NAME = "supportdesk_session";
const secret = new TextEncoder().encode(process.env.SESSION_SECRET || "supportdesk-local-change-this-secret");

export type Session = { userId: string; username: string; name: string; role: Role };

export async function authenticate(username: string, password: string): Promise<Session | null> {
  const users = await userRepository.list();
  const user = users.find((candidate) => candidate.username.toLowerCase() === username.toLowerCase() && candidate.active);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return null;
  return { userId: user.id, username: user.username, name: user.name, role: user.role };
}

export async function createSession(session: Session) {
  const token = await new SignJWT(session).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("12h").sign(secret);
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
    const { payload } = await jwtVerify(token, secret);
    return payload as unknown as Session;
  } catch {
    return null;
  }
}

export async function requireSession() {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}
