import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

const secret = new TextEncoder().encode(process.env.SESSION_SECRET || "supportdesk-local-change-this-secret");

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path === "/login" || path.startsWith("/api/auth/")) return NextResponse.next();
  const token = request.cookies.get("supportdesk_session")?.value;
  if (!token) return NextResponse.redirect(new URL("/login", request.url));
  try {
    await jwtVerify(token, secret);
    return NextResponse.next();
  } catch {
    return NextResponse.redirect(new URL("/login", request.url));
  }
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
