import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { getAppOrigin, getSessionSecret } from "@/lib/env";
import { isSafeMethod, isSameOriginRequest, jsonResponseWithRequestId } from "@/lib/request-security";

function sessionSecret() {
  return new TextEncoder().encode(getSessionSecret());
}

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (!isSafeMethod(request.method)) {
    try {
      if (!isSameOriginRequest({
        method: request.method,
        requestUrl: request.url,
        origin: request.headers.get("origin"),
        configuredOrigin: getAppOrigin(),
      })) {
        return jsonResponseWithRequestId({ error: "Request origin is not allowed", code: "INVALID_ORIGIN" }, request, { status: 403 });
      }
    } catch {
      return jsonResponseWithRequestId({ error: "Request origin is not allowed", code: "INVALID_ORIGIN" }, request, { status: 403 });
    }
  }
  if (path === "/login" || path.startsWith("/api/auth/") || path.startsWith("/api/health/")) return NextResponse.next();
  const token = request.cookies.get("supportdesk_session")?.value;
  if (!token) return NextResponse.redirect(new URL("/login", request.url));
  try {
    await jwtVerify(token, sessionSecret());
    return NextResponse.next();
  } catch {
    return NextResponse.redirect(new URL("/login", request.url));
  }
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
