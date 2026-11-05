/**
 * What this app checks for itself about a sign-in through the provider, on top
 * of what Better Auth's generic-oauth plugin checks.
 *
 * The plugin verifies the ID token — signature against the published keys,
 * issuer, audience, expiry, and the nonce of the request that asked — but it
 * takes the provider's discovery document as it finds it, accepts an ID token
 * with no nonce on its direct-token sign-in, fetches userinfo without comparing
 * its subject to the token's, and keys an identity on the subject alone. Each
 * of those is closed here, and each is small enough to read in one sitting.
 *
 * The pure parts (`discoveryProblems`, `authTimeVerdict`, `ssoAccountId`) are
 * checked in every case by `verify:sso`; the rest by driving the stand-in
 * provider through the real redirects.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getOAuthState } from "better-auth/api";

import type { OidcConfig } from "@/lib/auth-methods";
import { FRESH_AUTH_SECONDS } from "@/lib/auth-rules";

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Trailing slashes are the one difference two spellings of an issuer may have. */
export const sameIssuer = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" && a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

const ENDPOINTS = [
  "authorization_endpoint",
  "token_endpoint",
  "userinfo_endpoint",
  "jwks_uri",
  "end_session_endpoint",
] as const;
const REQUIRED = new Set<string>(["authorization_endpoint", "token_endpoint", "jwks_uri"]);

/**
 * Everything wrong with a discovery document, for the issuer this deployment
 * was configured with. Empty means it may be used.
 *
 * - **Its `issuer` is the one configured.** A document that names somebody
 *   else is not this provider's, whoever served it — and the ID tokens are
 *   checked against whatever issuer it names.
 * - **Every endpoint is `https://` when the issuer is.** The keys, the token
 *   exchange and the userinfo call are where identities come from; an issuer
 *   behind TLS that sends them over plain HTTP gives that away. An issuer that
 *   is itself plain `http://` — loopback, or the suites' stand-in under
 *   `OIDC_ALLOW_INSECURE_ISSUER` — was already allowed to be, by `oidcConfig`.
 */
export function discoveryProblems(doc: unknown, configuredIssuer: string): string[] {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return ["the discovery document is not a JSON object"];
  const d = doc as Record<string, unknown>;
  const problems: string[] = [];
  if (!sameIssuer(d.issuer, configuredIssuer)) {
    problems.push(`it names the issuer ${JSON.stringify(d.issuer)}, not the configured ${JSON.stringify(configuredIssuer)}`);
  }
  const httpsIssuer = configuredIssuer.startsWith("https://");
  for (const key of ENDPOINTS) {
    const value = d[key];
    if (value === undefined || value === null) {
      if (REQUIRED.has(key)) problems.push(`it has no ${key}`);
      continue;
    }
    let url: URL;
    try {
      url = new URL(String(value));
    } catch {
      problems.push(`its ${key} is not a URL: ${JSON.stringify(value)}`);
      continue;
    }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && !httpsIssuer)) {
      problems.push(`its ${key} is not https:// (${url.protocol}//${url.host})`);
    }
  }
  return problems;
}

export type Discovery = { ok: true; doc: Record<string, unknown> } | { ok: false; problems: string[] };

/**
 * The provider's discovery document as it stands now, checked.
 *
 * Fetched each time a sign-in starts rather than cached: it is one small GET
 * to the provider, on an action a person takes a few times a day, and a cache
 * would be a window in which a document that has changed is still believed.
 */
export async function currentDiscovery(cfg: OidcConfig): Promise<Discovery> {
  try {
    const res = await fetch(cfg.discoveryUrl, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!res.ok) return { ok: false, problems: [`the discovery document answered ${res.status}`] };
    const doc = (await res.json()) as Record<string, unknown>;
    const problems = discoveryProblems(doc, cfg.issuer);
    return problems.length ? { ok: false, problems } : { ok: true, doc };
  } catch (error) {
    return { ok: false, problems: [`the discovery document could not be read: ${String(error)}`] };
  }
}

// ---------------------------------------------------------------------------
// Who somebody is, and when they last proved it
// ---------------------------------------------------------------------------

/**
 * The key an identity at the provider is filed under: issuer and subject.
 *
 * A subject is only unique *at its issuer*. Filed under the subject alone,
 * pointing `OIDC_ISSUER` at another provider whose subjects happen to overlap —
 * small integers, usernames — would open the old provider's people's accounts
 * to whoever holds the same subject at the new one.
 */
export const ssoAccountId = (issuer: string, sub: string) => `${issuer.replace(/\/+$/, "")}|${sub}`;

/** How recently a re-authentication through the provider must have happened. */
export const REAUTH_MAX_AGE_SECONDS = 120;
/** How far ahead of this server's clock the provider's may be. */
const CLOCK_SKEW_SECONDS = 60;
/** The key, in the flow's server-side state, that marks it as a re-authentication. */
export const REAUTH_MARK = "pppReauth";

/**
 * Does this ID token's `auth_time` stand for the person at the keyboard now?
 *
 * Only asked of a re-authentication, which asked the provider for a fresh login
 * (`prompt=login`, `max_age=0`). A provider that ignored that and answered from
 * the session it already held reports an old `auth_time`; one that does not
 * report it at all leaves nothing to go on. Both are refused: the whole point
 * of re-authenticating is that somebody typed something just now.
 */
export function authTimeVerdict(authTime: unknown, nowSeconds: number): "fresh" | "stale" | "missing" {
  if (typeof authTime !== "number" || !Number.isFinite(authTime)) return "missing";
  if (authTime > nowSeconds + CLOCK_SKEW_SECONDS) return "stale";
  return nowSeconds - authTime <= REAUTH_MAX_AGE_SECONDS ? "fresh" : "stale";
}

/**
 * When a session opened through the provider counts as having been
 * authenticated, which is what `/reauth` measures (see src/lib/reauth.ts).
 *
 * Not the moment the session row was written: the provider may have signed
 * somebody in from a session it held for hours, with nobody typing anything.
 * The provider's `auth_time`, then, held to no later than now. Without one the
 * session is old enough not to count as fresh — a sign-in nobody can date is
 * not evidence that somebody is at the keyboard.
 */
export function ssoAuthenticatedAt(authTime: unknown, nowMs: number): Date {
  if (typeof authTime === "number" && Number.isFinite(authTime)) {
    return new Date(Math.min(authTime * 1000, nowMs));
  }
  return new Date(nowMs - (FRESH_AUTH_SECONDS + 1) * 1000);
}

/**
 * What the profile step learned, for the session hook later in the same
 * request. Set up per request by the auth route (src/app/api/auth/[...all]).
 */
type SsoRequest = { authenticatedAt?: Date };
const requestStore = new AsyncLocalStorage<SsoRequest>();
export const withSsoRequest = <T>(fn: () => T): T => requestStore.run({}, fn);
export const ssoRequest = () => requestStore.getStore();

/** The claims of a JWT whose signature has already been verified. */
function claimsOf(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

type Tokens = { idToken?: string; accessToken?: string };

/**
 * The provider's profile of who signed in — the generic-oauth plugin's
 * `getUserInfo`, replaced.
 *
 * The plugin has already verified the ID token by the time this runs, when
 * there is one. Here:
 *
 * - **There has to be one.** Without it nothing about the sign-in was verified.
 * - **Its `iss` is the configured issuer**, not merely the one the discovery
 *   document named.
 * - **A re-authentication has a recent `auth_time`** (`authTimeVerdict`).
 * - **Userinfo, when the token carries no address, is about the same
 *   subject.** The plugin's own fallback merges whatever the userinfo endpoint
 *   says for the access token it was handed.
 */
export async function ssoProfile(tokens: Tokens, cfg: OidcConfig, log: (message: string) => void) {
  const refuse = (why: string) => {
    log(`single sign-on refused: ${why}`);
    return null;
  };
  if (!tokens.idToken) return refuse("the provider sent no ID token");
  const claims = claimsOf(tokens.idToken);
  if (!claims) return refuse("the ID token could not be read");
  if (!sameIssuer(claims.iss, cfg.issuer)) return refuse(`the ID token was issued by ${JSON.stringify(claims.iss)}`);
  const sub = claims.sub;
  if (typeof sub !== "string" || !sub) return refuse("the ID token names no subject");

  const state = await getOAuthState();
  const reauth = (state?.serverContext as Record<string, unknown> | undefined)?.[REAUTH_MARK] === true;
  if (reauth) {
    const verdict = authTimeVerdict(claims.auth_time, Date.now() / 1000);
    if (verdict !== "fresh") {
      return refuse(
        verdict === "missing"
          ? "a re-authentication came back with no auth_time"
          : `a re-authentication came back with an auth_time of ${JSON.stringify(claims.auth_time)}, not just now`,
      );
    }
  }

  let profile: Record<string, unknown> = claims;
  if (typeof claims.email !== "string") {
    const discovery = await currentDiscovery(cfg);
    const endpoint = discovery.ok ? discovery.doc.userinfo_endpoint : undefined;
    if (typeof endpoint === "string" && tokens.accessToken) {
      try {
        const res = await fetch(endpoint, {
          headers: { authorization: `Bearer ${tokens.accessToken}` },
          signal: AbortSignal.timeout(10_000),
          cache: "no-store",
        });
        const info = res.ok ? ((await res.json()) as Record<string, unknown>) : null;
        if (info && info.sub !== sub) return refuse("userinfo answered for a different subject than the ID token");
        if (info) profile = { ...info, ...claims };
      } catch (error) {
        log(`single sign-on: userinfo could not be read: ${String(error)}`);
      }
    }
  }

  const store = ssoRequest();
  if (store) store.authenticatedAt = ssoAuthenticatedAt(claims.auth_time, Date.now());

  return {
    ...profile,
    sub,
    email: typeof profile.email === "string" ? profile.email : undefined,
    emailVerified: profile.email_verified === true,
    name: typeof profile.name === "string" ? profile.name : undefined,
  };
}

/**
 * Better Auth answers an unverified address in two ways: `email_not_verified`
 * when nobody has the address, `account_not_linked` when somebody does. The
 * difference is whether the address is a member here, so the browser is told
 * the first in both cases.
 */
export function sameAnswerForUnverified(res: Response): Response {
  const location = res.headers.get("location");
  if (!location || !/[?&]error=account_not_linked(&|$)/.test(location)) return res;
  const headers = new Headers(res.headers);
  headers.set("location", location.replace(/([?&]error=)account_not_linked(?=&|$)/, "$1email_not_verified"));
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
