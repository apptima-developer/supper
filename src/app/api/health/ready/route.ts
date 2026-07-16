import { NextResponse } from "next/server";
import { validateRuntimeEnvironment } from "@/lib/env";

export const dynamic = "force-dynamic";

export function GET() {
  const readiness = validateRuntimeEnvironment();
  return NextResponse.json(
    {
      application: "SUPPER Support Control System",
      status: readiness.ok ? "ready" : "not_ready",
      backend: readiness.backend,
      checks: readiness.checks,
    },
    { status: readiness.ok ? 200 : 503 },
  );
}
