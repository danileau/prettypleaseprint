import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { buildCsp, newNonce } from "@/lib/csp";
import { SESSION_COOKIE_NAMES, SESSION_IDLE_SECONDS } from "@/lib/auth-rules";

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

  /**
   * Better Auth's `openAPI()` plugin is enabled so `src/lib/openapi.ts` can
   * ask it to describe the auth surface — in process, as
   * `auth.api.generateOpenAPISchema()`. The plugin also mounts that as an
   * HTTP endpoint, and answers it to anybody with no session at all.
   *
   * Nothing calls it over HTTP, so it is closed here rather than left open on
   * the reasoning that it "only" leaks metadata. It would tell a stranger
   * which auth plugins this deployment runs and every path they expose, which
   * is precisely what /api/health is deliberately terse about. 404 rather
   * than 401, because as far as any caller is concerned it does not exist.
   *
   * The plugin offers no option to skip mounting it; if it ever does, this
   * goes away.
   */
  if (pathname.startsWith("/api/auth/open-api")) {
    return withCsp(new NextResponse(null, { status: 404 }));
  }

  /*
   * The admin plugin's whole HTTP surface, closed for the same reason and with
   * more at stake.
   *
   * `admin()` is enabled in src/lib/auth.ts for what it adds to the schema and
   * to sign-in — the `role` and `banned` fields, and the refusal to create a
   * session for a suspended account. It also mounts a dozen endpoints this app
   * does not use: every admin screen goes through Prisma directly
   * (`db.user.findMany` for the member list, `db.user.update` for suspension),
   * and `authClient.admin` is never called from the browser.
   *
   * Measured before closing them, rather than assumed, because the assumption
   * was wrong. With an admin session most of this surface already refused:
   * set-user-password, remove-user, ban-user, update-user, list-user-sessions
   * and revoke-user-sessions all answered 403 from the plugin's own access
   * control, and create-user answered 403 from this app's invite hook. Two did
   * not:
   *
   *   impersonate-user   200, with a session token for another account. Not
   *                      theoretical — the probe that called it had its own
   *                      browser become that user, and the next check found
   *                      /admin/invites rendering an error page because the
   *                      caller was no longer an admin. This is the primitive
   *                      that recovery deliberately stopped using; the audit
   *                      doc says "access.reissued … is gone", and it was not.
   *   list-users         200, with every account's name, e-mail and verified
   *                      flag. A roster, to anyone holding an admin cookie.
   *
   * And set-role answered 500, which is an unhandled path rather than a refusal.
   *
   * The 403s are the reason to close the whole prefix rather than those two.
   * They come from Better Auth's default permission statements — not from
   * anything this app asserts — so they can widen on a version bump without a
   * line of this repository changing. Nothing here writes to the audit trail
   * either, and every path is listed at /api/openapi.json for any signed-in
   * client to read.
   *
   * It matters because src/lib/reauth.ts exists on the reasoning that four
   * actions outlive a session, so each asks for the password or passkey again
   * when the sign-in is over five minutes old — "the thief has the session, not
   * the passkey". A copied admin cookie could reach impersonation inside its
   * twenty idle minutes without ever meeting that bar.
   *
   * The whole prefix rather than a list of names, so a plugin version that adds
   * an endpoint has it closed by default instead of newly exposed. In-process
   * calls are unaffected: middleware sees HTTP, and `auth.api.*` from a server
   * component never becomes a request.
   */
  if (pathname.startsWith("/api/auth/admin/")) {
    return withCsp(new NextResponse(null, { status: 404 }));
  }

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
    const res = withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
    // Route handlers set their own cookies; a page render cannot. See below.
    if (!isApi) restampSession(request, res);
    return res;
  }

  const signin = new URL("/signin", request.url);
  signin.searchParams.set("next", pathname + search);
  return withCsp(NextResponse.redirect(signin));
}

/**
 * Re-stamp the session cookie's `Max-Age` on a page navigation.
 *
 * Better Auth slides a live session two ways at once: it pushes `expiresAt`
 * out in the database, and it re-sets the cookie with a fresh `Max-Age`. Only
 * the first of those survives a React Server Component render, because Next
 * forbids writing a cookie during one. So browsing pages keeps the session row
 * alive while the browser's copy of the cookie counts down from whenever a
 * route handler last wrote it.
 *
 * At the thirty-day window this app used to run, nobody would ever have hit
 * that. At twenty minutes it signs people out in the middle of working — row
 * alive, cookie gone. Measured rather than assumed: `GET /board` sends no
 * `Set-Cookie` at all, where `GET /api/stories` sends `Max-Age=1200`.
 *
 * Re-stamping is safe because the cookie is not the authority. It carries a
 * token whose validity is the `session` row, and `getSession` refuses an
 * expired row, so keeping the browser's copy for longer cannot extend a
 * session by one second. What it buys is the invariant worth having: the
 * cookie never dies before the row it names, and the two now slide on exactly
 * the same requests.
 *
 * `/api/*` is deliberately excluded. Those responses can and do set the cookie
 * themselves — and re-stamping there would resurrect the one that
 * `/api/auth/sign-out` had just deleted.
 */
function restampSession(request: NextRequest, response: NextResponse): void {
  for (const name of SESSION_COOKIE_NAMES) {
    const cookie = request.cookies.get(name);
    if (!cookie) continue;
    response.cookies.set({
      name,
      value: cookie.value,
      maxAge: SESSION_IDLE_SECONDS,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      // `__Secure-` is a promise to the browser that the cookie only ever
      // travels over HTTPS, and it refuses the cookie outright without it.
      secure: name.startsWith("__Secure-"),
    });
    return;
  }
}

export const config = {
  // Everything except static assets, which need no nonce and no session.
  //
  // `icon.svg` is on this list because leaving it off put the favicon behind
  // the sign-in redirect: a signed-out browser asked for it, got a 307 to
  // /signin, and rendered no icon at all — on precisely the pages where the
  // brand is doing the most work. It is a public brand asset; there is
  // nothing there to protect.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.png$).*)"],
};
