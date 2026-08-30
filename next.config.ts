import type { NextConfig } from "next";

import { MAX_REQUEST_BYTES } from "./src/lib/upload-limits";

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
  experimental: {
    /**
     * Let an upload actually be as large as the app says it is.
     *
     * Next caps a request body at 10 MB whenever middleware is in play, and
     * this app runs middleware on everything (it mints the CSP nonce). So the
     * advertised 50 MB limit was never real: anything past 10 MB was truncated
     * before the route handler saw it, `request.formData()` threw on the short
     * body, and the uploader was told "That upload did not arrive intact" —
     * which reads like a network problem and sent people looking in the wrong
     * place. Found by uploading a 20 MB file, which no suite had ever done.
     *
     * Kept in step with the validator's own cap rather than written out
     * separately, because two numbers that must agree and live apart do not
     * stay agreeing.
     */
    middlewareClientMaxBodySize: MAX_REQUEST_BYTES,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
