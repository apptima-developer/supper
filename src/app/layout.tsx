import type { Metadata } from "next";
import "@fontsource/prompt/300.css";
import "@fontsource/prompt/400.css";
import "@fontsource/prompt/500.css";
import "@fontsource/prompt/600.css";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  applicationName: "SUPPER",
  title: { default: "SUPPER - Support Control System", template: "%s | SUPPER" },
  description: "Internal support operations and maintenance-day control",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/brand/supper-favicon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/brand/supper-favicon-512.png", type: "image/png", sizes: "512x512" },
    ],
    shortcut: "/favicon.ico",
    apple: [{ url: "/brand/supper-favicon-180.png", type: "image/png", sizes: "180x180" }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {children}
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
