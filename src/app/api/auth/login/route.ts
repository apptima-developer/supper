import { NextResponse } from "next/server";
import { authenticate, createSession } from "@/lib/auth";

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const session = await authenticate(String(form.get("username") || ""), String(form.get("password") || ""));
    if (!session) return NextResponse.redirect(new URL("/login?error=1", request.url), 303);
    await createSession(session);
    return NextResponse.redirect(new URL("/dashboard", request.url), 303);
  } catch (error) {
    console.error("Login failed", error);
    return NextResponse.redirect(new URL("/login?error=setup", request.url), 303);
  }
}
