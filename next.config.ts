import { execSync } from "node:child_process";
import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV !== "production";
const usesHttps = (process.env.APP_URL || "").startsWith("https://");
const scriptPolicy = isDevelopment
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

/**
 * Build identity is evaluated when Next loads this config, including at build and service start.
 * The `env` values below are inlined into each compiled bundle during `next build`; /api/health
 * therefore reports its compiled values, not values recalculated at service start or request time.
 * Falls back to "unknown" so a build without git still succeeds.
 */
function gitValue(command: string): string {
  try {
    return execSync(command, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

const buildCommit = gitValue("git rev-parse --short HEAD") || "unknown";
const buildTime = new Date().toISOString();

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
  {
    key: "Content-Security-Policy",
    // form-action allows https because the OAuth consent page submits a form and the app
    // then redirects that submission to the connector's own https callback (claude.ai,
    // ChatGPT). Every in-app form still posts to 'self'; the alternative was a meta
    // refresh, which drops the connector's state cookie and breaks its callback.
    value: `default-src 'self'; base-uri 'self'; form-action 'self' https:; frame-ancestors 'none'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; ${scriptPolicy}; connect-src 'self' https:; object-src 'none'`,
  },
  ...(isDevelopment || !usesHttps
    ? []
    : [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]),
];

const nextConfig: NextConfig = {
  devIndicators: false,
  // Read by src/lib/build-info.ts through process.env at request time; these two values are
  // substituted into the server bundle at build time, which is what makes them describe the
  // running build rather than the working tree.
  env: {
    BUILD_COMMIT: buildCommit,
    BUILD_TIME: buildTime,
  },
  serverExternalPackages: [
    "@electric-sql/pglite",
    "imapflow",
    "mailparser",
    "nodemailer",
    "pg",
  ],
  // The local PGlite database lives inside the project at .data/pglite and rewrites its
  // files constantly. Without this the dev watcher saw every write, recompiled, and burned
  // a full core while idle. Nothing under .data is ever imported by the app.
  webpack(config, { dev }) {
    if (dev) {
      config.watchOptions = {
        ...(config.watchOptions ?? {}),
        ignored: ["**/node_modules/**", "**/.next/**", "**/.data/**", "**/.agents/**"],
      };
    }
    return config;
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
