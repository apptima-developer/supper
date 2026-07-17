import { NextResponse } from "next/server";
import { authenticate, createSession } from "@/lib/auth";
import { getRequestLimits } from "@/lib/env";
import { clientNetworkIdentifier, createLoginRateLimitKey, getLoginRateLimitStore } from "@/lib/login-rate-limit";
import { assertContentLength } from "@/lib/request-security";
import { logServerError } from "@/lib/server-logging";

function rateLimited(retryAfterSeconds: number) {
  return NextResponse.json(
    { error: "Authentication failed", code: "AUTHENTICATION_FAILED" },
    { status: 429, headers: { "Retry-After": String(Math.max(1, retryAfterSeconds)) } },
  );
}

export async function POST(request: Request) {
  try {
    assertContentLength(request, getRequestLimits().maxJsonBodyBytes);
    const form = await request.formData();
    const username = String(form.get("username") || "");
    const key = createLoginRateLimitKey(username, clientNetworkIdentifier(request));
    const store = getLoginRateLimitStore();
    const current = await store.check(key, new Date());
    if (current.limited) return rateLimited(current.retryAfterSeconds);

    const session = await authenticate(username, String(form.get("password") || ""));
    if (!session) {
      const failed = await store.recordFailure(key, new Date());
      if (failed.limited) return rateLimited(failed.retryAfterSeconds);
      return NextResponse.redirect(new URL("/login?error=1", request.url), 303);
    }
    await store.reset(key);
    await createSession(session);
    return NextResponse.redirect(new URL("/dashboard", request.url), 303);
  } catch (error) {
    logServerError("login_failed", error);
    return NextResponse.redirect(new URL("/login?error=1", request.url), 303);
  }
}
