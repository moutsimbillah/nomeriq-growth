import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV !== "production";
const usesHttps = (process.env.APP_URL || "").startsWith("https://");
const scriptPolicy = isDevelopment
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

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
    value: `default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; ${scriptPolicy}; connect-src 'self' https:; object-src 'none'`,
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
  serverExternalPackages: [
    "@electric-sql/pglite",
    "imapflow",
    "mailparser",
    "nodemailer",
    "pg",
  ],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
