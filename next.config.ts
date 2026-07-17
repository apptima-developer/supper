import type { NextConfig } from "next";
import { buildSecurityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  async headers() {
    return [{
      source: "/(.*)",
      headers: buildSecurityHeaders({
        production: process.env.NODE_ENV === "production",
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      }),
    }];
  },
};

export default nextConfig;
