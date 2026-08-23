import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// The CSP is per-request (it carries a nonce) and therefore lives in
// middleware.ts — see src/lib/csp.ts.

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Passkeys need publickey-credentials-get/create on this origin only.
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), " +
      "interest-cohort=(), browsing-topics=(), " +
      "publickey-credentials-get=(self), publickey-credentials-create=(self)",
  },
  // Cross-origin isolation. COOP severs window handles to other origins, so a
  // popup cannot reach back into this document; CORP stops other sites
  // embedding our responses.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  // COEP is deliberately "credentialless" rather than "require-corp": Google
  // Fonts serves no CORP header, and require-corp would block the webfonts.
  { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
  ...(isProd
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  // Traced, self-contained server bundle — the container copies this instead
  // of a full node_modules tree.
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["@prisma/client", "nodemailer"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
