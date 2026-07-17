import { NextResponse } from "next/server";
import { authenticate, createSession } from "@/lib/auth";
import { clientNetworkIdentifier, createLoginRateLimitKey, getLoginRateLimitStore } from "@/lib/login-rate-limit";
import { HttpError, readLoginFormBody, safeErrorResponse } from "@/lib/request-security";
import { logServerError } from "@/lib/server-logging";

function rateLimited(retryAfterSeconds: number) {
  return NextResponse.json(
    { error: "Authentication failed", code: "AUTHENTICATION_FAILED" },
    { status: 429, headers: { "Retry-After": String(Math.max(1, retryAfterSeconds)) } },
  );
}

export async function POST(request: Request) {
  try {
    const { username, password } = await readLoginFormBody(request);
    const key = createLoginRateLimitKey(username, clientNetworkIdentifier(request));
    const store = getLoginRateLimitStore();
    const current = await store.check(key, new Date());
    if (current.limited) return rateLimited(current.retryAfterSeconds);

    const session = await authenticate(username, password);
    if (!session) {
      const failed = await store.recordFailure(key, new Date());
      if (failed.limited) return rateLimited(failed.retryAfterSeconds);
      return NextResponse.redirect(new URL("/login?error=1", request.url), 303);
    }
    await store.reset(key);
    await createSession(session);
    return NextResponse.redirect(new URL("/dashboard", request.url), 303);
  } catch (error) {
    if (error instanceof HttpError) return safeErrorResponse(error, "Could not process login request", request, error.status);
    logServerError("login_failed", error);
    return NextResponse.redirect(new URL("/login?error=1", request.url), 303);
  }
}
