import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// the release this build belongs to, so an open page can tell when a newer one has been deployed
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:4000";
const dev = process.env.NODE_ENV !== "production";

// the app talks to the API through this origin, so the session cookie is first-party and CORS is not involved
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${dev ? " ws:" : ""}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const config: NextConfig = {
  output: "standalone",
  env: { NEXT_PUBLIC_APP_VERSION: version },
  experimental: {
    // pages render on the client and fetch their own data, so a page visited or prefetched in the last few minutes
    // can be shown again at once instead of asking the server first (which can take a second from a phone in China)
    staleTimes: { dynamic: 300, static: 600 },
  },
  // trace dependencies from the monorepo root so the standalone server finds hoisted packages
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  poweredByHeader: false,
  reactStrictMode: true,
  // the dev badge sits where the phone tab bar floats
  devIndicators: false,
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${API_ORIGIN}/api/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
    ];
  },
};

export default config;
