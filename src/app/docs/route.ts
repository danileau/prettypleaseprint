import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { currentUser } from "@/lib/authz";
import { sourceUrl } from "@/lib/runtime";

/**
 * The API console.
 *
 * A route handler rather than a page, deliberately. Swagger UI ships a large
 * stylesheet that expects to own the document, and the app's root layout owns
 * this one — four self-hosted webfonts, a diner palette and a paper texture.
 * Rendering one inside the other means two design systems arguing in every
 * cell of every table. Serving a plain document sidesteps that, and it is also
 * honest: this page is a tool for reading the API, not part of the product's
 * surface.
 *
 * It is behind a session for the same reason `/api/openapi.json` is: it
 * describes an invite-only app to the people already inside it. Middleware
 * only checks that a session cookie is *present*, so the real check is here —
 * a forged cookie gets a redirect to sign-in, not a console.
 *
 * Everything it loads comes from this origin: `scripts/vendor-swagger.ts`
 * copies Swagger UI into `public/docs/` at build time, so the page needs no
 * CSP relaxation and works on a deployment with no outbound internet.
 *
 * Two consequences of keeping the CSP intact, both of which are easy to get
 * wrong because getting them wrong still renders a page:
 *
 *   - The one inline script carries the request's nonce. Without it,
 *     production serves a document that loads Swagger UI and then never calls
 *     it — a blank frame under a header, with nothing in the log.
 *   - The console's own styling is a **file**, `public/api-console.css`, not
 *     an inline `<style>` block. `style-src` is `'self'` with no nonce for
 *     styles, so a block is dropped and the header simply arrives unstyled.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The nonce middleware minted for this request. Base64 of 16 CSPRNG bytes. */
function nonceFrom(value: string | null): string {
  return value && /^[A-Za-z0-9+/=]{1,64}$/.test(value) ? value : "";
}

/**
 * Two settings worth explaining.
 *
 * `withCredentials` makes Swagger UI request with `credentials: "include"`
 * rather than its default `"same-origin"`. On this deployment the two are the
 * same thing — the console and the API share an origin — so it is stating the
 * intent rather than fixing anything. Note it is not a way to drive the API
 * from somewhere else: the app serves no CORS headers, so a cross-origin call
 * fails at the preflight regardless.
 *
 * `syntaxHighlight: false` is the difference between a console and a stall.
 * The document runs to 71 operations once Better Auth's half is folded in, and
 * highlighting every example is far and away the most expensive thing Swagger
 * UI does: rendering the lot took **147 ms with it off and about 55 seconds
 * with it on**, measured in Chrome against this build. Examples render as
 * plain monospace instead, which for a page people read to find a path is not
 * a loss worth four hundred times the wait.
 */
const INIT = `
  window.ui = SwaggerUIBundle({
    url: "/api/openapi.json",
    dom_id: "#swagger",
    presets: [SwaggerUIBundle.presets.apis],
    layout: "BaseLayout",
    deepLinking: true,
    withCredentials: true,
    tryItOutEnabled: true,
    filter: true,
    docExpansion: "none",
    defaultModelsExpandDepth: 0,
    displayRequestDuration: true,
    syntaxHighlight: false,
    persistAuthorization: false,
  });
`;

export async function GET() {
  const user = await currentUser();
  if (!user) redirect("/signin?next=%2Fdocs");

  const nonce = nonceFrom((await headers()).get("x-nonce"));
  const n = nonce ? ` nonce="${nonce}"` : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>API · Pretty Please Print</title>
<link rel="icon" href="/icon.svg">
<link rel="stylesheet" href="/docs/swagger-ui.css">
<!-- A file, not an inline block: \`style-src 'self'\` drops the latter, and the
     page still renders — just unstyled, which is a failure that hides. -->
<link rel="stylesheet" href="/api-console.css">
</head>
<body>
<header class="console-head">
  <h1>Pretty Please Print — API</h1>
  <p>
    You are signed in as <strong>${escapeHtml(user.name)}</strong> (${user.role}), and
    <em>Try it out</em> already carries that session — there is nothing to paste.
    <strong>Authorize</strong> is only for a bearer token, which you get from the
    <code>set-auth-token</code> header on any sign-in response; it is the same session
    token, so signing out revokes it.
    Written up in <a href="${escapeHtml(sourceUrl())}/blob/main/docs/api.md">docs/api.md</a>.
  </p>
</header>
<div id="swagger"></div>
<script src="/docs/swagger-ui-bundle.js"${n} defer></script>
<script${n}>window.addEventListener("DOMContentLoaded", function () {${INIT}});</script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Names the caller, so it is never shared by a proxy between accounts.
      "cache-control": "private, no-store",
    },
  });
}

/** The header greets you by name, and a name is whatever somebody typed. */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
