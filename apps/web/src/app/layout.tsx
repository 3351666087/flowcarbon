import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import { LOCALE_COOKIE, type Locale } from "@/lib/format";
import { EARLY_SCRIPT } from "@/lib/theme";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: { default: "FlowCarbon", template: "%s · FlowCarbon" },
  description: "Occupancy-driven after-hours energy management for office buildings.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // content runs under the system bars; the app shell and safe areas pad it back (--app-top, --app-bottom)
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f6f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0d1117" },
  ],
};

/** The reader's language for the first paint: their earlier choice, else what the browser asks for. */
async function initialLocale(): Promise<Locale> {
  const saved = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (saved === "en" || saved === "zh") return saved;
  return /^zh\b/i.test((await headers()).get("accept-language") ?? "") ? "zh" : "en";
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await initialLocale();
  return (
    <html lang={locale === "zh" ? "zh-CN" : "en"} suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed script that must run before first paint */}
        <script dangerouslySetInnerHTML={{ __html: EARLY_SCRIPT }} />
      </head>
      <body>
        <Providers locale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
