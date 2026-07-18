import { NextResponse } from "next/server";
import { authenticate, createSession } from "@/lib/auth";
import { clientNetworkIdentifier, createLoginRateLimitKey, getLoginRateLimitStore } from "@/lib/login-rate-limit";
import { HttpError, jsonResponseWithRequestId, readLoginFormBody, requestId, safeErrorResponse, withRequestId } from "@/lib/request-security";
import { logServerError } from "@/lib/server-logging";

function rateLimited(retryAfterSeconds: number, correlationId: string) {
  return jsonResponseWithRequestId(
    { error: "Authentication failed", code: "AUTHENTICATION_FAILED" },
    undefined,
    { status: 429, headers: { "Retry-After": String(Math.max(1, retryAfterSeconds)) } },
    correlationId,
  );
}

export async function POST(request: Request) {
  const correlationId = requestId(request);
  try {
    const { username, password } = await readLoginFormBody(request);
    const key = createLoginRateLimitKey(username, clientNetworkIdentifier(request));
    const store = getLoginRateLimitStore();
    const current = await store.check(key, new Date());
    if (current.limited) return rateLimited(current.retryAfterSeconds, correlationId);

    const session = await authenticate(username, password);
    if (!session) {
      const failed = await store.recordFailure(key, new Date());
      if (failed.limited) return rateLimited(failed.retryAfterSeconds, correlationId);
      return withRequestId(NextResponse.redirect(new URL("/login?error=1", request.url), 303), correlationId);
    }
    await store.reset(key);
    await createSession(session);
    return withRequestId(NextResponse.redirect(new URL("/dashboard", request.url), 303), correlationId);
  } catch (error) {
    if (error instanceof HttpError) return safeErrorResponse(error, "Could not process login request", request, error.status, correlationId);
    logServerError("login_failed", error, { requestId: correlationId, route: "/api/auth/login", operation: "login" });
    return withRequestId(NextResponse.redirect(new URL("/login?error=1", request.url), 303), correlationId);
  }
}
