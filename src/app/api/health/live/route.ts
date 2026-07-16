import { NextResponse } from "next/server";
import packageJson from "../../../../../package.json";

export const dynamic = "force-static";

export function GET() {
  return NextResponse.json({
    application: "SUPPER Support Control System",
    status: "live",
    version: packageJson.version,
  });
}
