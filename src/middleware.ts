import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { buildCsp, newNonce } from "@/lib/csp";

/**
 * Two jobs, both cheap enough to run on every request.
 *
 * 1. Mint a CSP nonce and attach the policy. Next reads the policy back off
 *    the *request* headers to stamp the nonce onto its own inline scripts,
 *    which is why it is set in both directions.
 *
 * 2. Redirect visitors with no session cookie, so they get the sign-in page
 *    instead of a shell that flashes and then bounces.
 *
 * The second is NOT the authorisation boundary. It only checks that a cookie
 * is *present* — validating the session here would put a database round trip
 * in front of every request. The real checks are `requireUser`,
 * `requireAdmin` and `storyScope`, which run inside every page and every
 * server action. A forged cookie gets past this file and no further; there is
 * a probe for exactly that (A01-forge).
 */
/**
 * Pages anyone may reach without a session.
 *
 * `/set-password` is on the list for the same reason `/invite` is: the whole
 * point of the link is that somebody who cannot get in can use it. It grants
 * nothing on its own — the token is checked by the page and again by the
 * action behind it.
 */
const PUBLIC_PREFIXES = ["/signin", "/invite", "/set-password"];

const isProd = process.env.NODE_ENV === "production";

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const nonce = newNonce();
  const csp = buildCsp(nonce, isProd);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const withCsp = (res: NextResponse) => {
    res.headers.set("content-security-policy", csp);
    return res;
  };

  // API routes are never redirected. A caller that is not signed in needs a
  // 401 with a JSON body, not a 307 to an HTML page it cannot parse — an XHR
  // upload following that redirect would report a mystifying success.
  //
  // The consequence is that every route handler under /api owes its own
  // authorisation check. `currentUser()` / `requireAdmin()` from authz.ts is
  // how; there is a probe (A01-anon-api) that an unauthenticated POST to
  // /api/upload comes back 401.
  const isApi = pathname.startsWith("/api/");
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
  const hasCookie = getSessionCookie(request, { cookiePrefix: "ppp" });

  if (isApi || isPublic || hasCookie) {
    return withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
  }

  const signin = new URL("/signin", request.url);
  signin.searchParams.set("next", pathname + search);
  return withCsp(NextResponse.redirect(signin));
}

export const config = {
  // Everything except Next's own static assets, which need no nonce.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.png$).*)"],
};
