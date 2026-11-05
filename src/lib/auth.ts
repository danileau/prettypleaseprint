import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins/admin";
import { bearer } from "better-auth/plugins/bearer";
import { openAPI } from "better-auth/plugins";
import { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned";
import { username } from "better-auth/plugins/username";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { passkey } from "@better-auth/passkey";
import { APIError, addOAuthServerContext, createAuthMiddleware, getOAuthState, getSessionFromCtx } from "better-auth/api";

import { db } from "@/lib/db";
import {
  normalizeEmail,
  pendingInviteFor,
  consumeInvitesFor,
  isClaimingInvite,
} from "@/lib/invites";
import { initialsFor } from "@/lib/tokens";
import { FRESH_AUTH_SECONDS } from "@/lib/auth-rules";
import { isBuildPhase } from "@/lib/runtime";
import { enabledSources } from "@/lib/import-source";
import {
  OIDC_PROVIDER_ID,
  authMethods,
  disabledAuthPaths,
  mayProvision,
  oidcConfig,
} from "@/lib/auth-methods";
import { record } from "@/lib/audit";
import {
  REAUTH_MARK,
  currentDiscovery,
  currentIssuerAccounts,
  sameIssuer,
  ssoAccountId,
  ssoProfile,
  ssoRequest,
} from "@/lib/oidc-flow";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  SESSION_IDLE_SECONDS,
  USERNAME_MAX,
  USERNAME_MIN,
  USERNAME_PATTERN,
} from "@/lib/auth-rules";

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const isProd = process.env.NODE_ENV === "production";

/**
 * Cookie hardening keys off the deployment URL, not NODE_ENV.
 *
 * A `Secure` cookie is discarded by the browser over plain HTTP, so tying the
 * flag to NODE_ENV means a production build cannot be exercised locally at
 * all, while an HTTPS deployment that happens to boot with NODE_ENV unset
 * would silently ship unprotected cookies. The scheme of the URL the app is
 * actually served from is the honest signal. The guard below makes sure that
 * signal is right in production.
 */
const isHttps = baseURL.startsWith("https://");

/** localhost is never a real deployment, whatever NODE_ENV happens to say. */
const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(
  baseURL,
);

// Not an authentication setting, and here anyway: this is the module every
// request loads, which is what makes it where configuration is refused. A
// misspelt IMPORT_SOURCES throws by name on the first request instead of
// quietly meaning "off" — see `enabledSources`.
if (!isBuildPhase) enabledSources();

/**
 * How people sign in here — see `src/lib/auth-methods.ts`.
 *
 * Read once, at load, and refused by name if it does not add up: a provider
 * with no client secret, an issuer over plain HTTP, a method that is not one.
 * During `next build` there is no deployment environment to read, so the build
 * sees the default (local only) and the guards wait for the first request.
 */
const methods = isBuildPhase ? { local: true, oidc: false } : authMethods();
const oidc = isBuildPhase ? null : oidcConfig();

if (isProd && !isBuildPhase) {
  if (!process.env.BETTER_AUTH_SECRET) {
    throw new Error("BETTER_AUTH_SECRET is required in production.");
  }
  if (!isHttps && !isLoopback) {
    throw new Error(
      `BETTER_AUTH_URL must be an https:// URL in production (got "${baseURL}"). ` +
        "Session cookies carry the Secure flag and passwords are posted to " +
        "this origin; neither is safe to serve over plain HTTP.",
    );
  }
  if (isLoopback) {
    console.warn(
      "[auth] Production build served from " +
        `${baseURL} — session cookies are NOT marked Secure. Fine for a local ` +
        "smoke test, never for a real deployment.",
    );
  }
}

/**
 * May this identity at the provider be attached to an existing account?
 * Better Auth asks with `action: "link-account"` both when it links one
 * implicitly — a first sign-in whose verified address matches an account — and
 * when somebody connects one on purpose through `/link-social`.
 *
 * - **On purpose:** the account being linked has to be the one signed in now.
 *   The flow's state names it; the session in the browser that comes back has
 *   to be the same person.
 * - **Implicitly:** anybody but the printer owner. A provider that asserts the
 *   owner's address does not become the owner by doing so; the owner connects
 *   it from /me. The refusal is word for word the one an address nobody here
 *   has gets, so it does not say whose address it was.
 */
async function linkRule(
  userId: string,
  source: { oauth?: { providerId?: string } },
  context: Parameters<typeof getSessionFromCtx>[0],
): Promise<{ error: string; errorDescription: string } | void> {
  if (source.oauth?.providerId !== OIDC_PROVIDER_ID) return;
  const NOT_INVITED = {
    error: "invite_required",
    errorDescription: "Pretty Please Print is invite-only. Ask the printer owner for a link.",
  };
  const state = await getOAuthState();
  const link = state?.link as { userId?: string } | undefined;
  if (link) {
    const session = await getSessionFromCtx(context).catch(() => null);
    if (link.userId && link.userId === userId && session?.user.id === userId) return;
    return NOT_INVITED;
  }
  const target = await db.user.findUnique({ where: { id: userId }, select: { email: true, role: true } });
  if (target?.role === "admin") {
    await record({
      action: "auth.sso_link_refused",
      subject: target.email,
      detail: { reason: "owner_not_connected", provider: oidc?.issuer ?? null },
    });
    return NOT_INVITED;
  }
}

/**
 * With passwords off, the owner gets in through the provider or not at all,
 * and is never linked to it implicitly. Said at start, loudly, if nothing
 * connects them yet — the guest list says it too.
 */
if (!isBuildPhase && oidc && !methods.local) {
  void db.account
    .count({ where: { ...currentIssuerAccounts(oidc.issuer), user: { role: "admin" } } })
    .then((n) => {
      if (n === 0) {
        console.error(
          "[auth] AUTH_METHODS has no `local`, and the printer owner has not connected single sign-on. " +
            "Nobody can sign in as the owner. Start with AUTH_METHODS=local,oidc, connect the provider " +
            "from /me, then turn local off — docs/deployment.md#single-sign-on.",
        );
      }
    })
    .catch(() => {});
}

/** See `disabledPaths` below, and the first rule in `hooks.before`. */
const disabled = new Set(disabledAuthPaths(methods));

export const auth = betterAuth({
  appName: "Pretty Please Print",
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(db, { provider: "postgresql" }),

  /**
   * Username and password is how people get in.
   *
   * `requireEmailVerification` stays off: the address was verified by
   * construction. An account is only ever opened by redeeming an invite link
   * that was delivered to that mailbox — the sign-up endpoint is reachable by
   * anyone, and the invite gate below refuses every request that is not such
   * a redemption.
   */
  emailAndPassword: {
    enabled: true,
    minPasswordLength: PASSWORD_MIN,
    maxPasswordLength: PASSWORD_MAX,
    // Registration hands back a session; there is no second hop to /signin.
    autoSignIn: true,
    /**
     * A reset is what you do when you have lost control of the account, so
     * every session opened with the old password dies with it.
     */
    revokeSessionsOnPasswordReset: true,
    // Self-service "forgot password" is deliberately absent: with no
    // `sendResetPassword` configured, /request-password-reset refuses. Resets
    // are minted by the admin (src/lib/password-reset.ts) so the flow does
    // not depend on a mail server that may not exist.
  },

  trustedOrigins: [baseURL],

  /**
   * A method that is off is off at the endpoint, not just missing from the
   * page. See `disabledAuthPaths`.
   */
  disabledPaths: [...disabled],

  hooks: {
    /**
     * Rules for the endpoints themselves, whoever calls them.
     */
    before: createAuthMiddleware(async (ctx) => {
      // `disabledPaths` is enforced by the HTTP router only. The same
      // endpoints called in process — `auth.api.signUpEmail` from a server
      // action, say — go straight past it, so a method that is off is refused
      // here as well.
      if (disabled.has(ctx.path)) throw new APIError("NOT_FOUND");

      const linking = ctx.path === "/link-social";
      if (ctx.path !== "/sign-in/social" && !linking) return;
      const body = (ctx.body ?? {}) as {
        provider?: unknown;
        idToken?: unknown;
        additionalData?: Record<string, unknown>;
        additionalParams?: Record<string, string>;
      };

      // `/sign-in/social` has a second branch: post an ID token and be signed
      // in on it, with no state, no PKCE, a nonce only if the caller offers
      // one, and — when the token carries no address — a userinfo lookup with
      // whatever access token the caller sends alongside. `/link-social` has
      // the same branch for attaching one. The redirect flow is the only one
      // this app offers, for every provider.
      if (body.idToken !== undefined) throw new APIError("NOT_FOUND");

      if (linking) {
        // Connecting the provider to an account on request is for the printer
        // owner alone — everybody else is linked by their verified address
        // when they first sign in — and only on a session fresh enough to move
        // access around: this is a new way into the owner's account.
        if (!oidc || body.provider !== OIDC_PROVIDER_ID) throw new APIError("NOT_FOUND");
        const session = await getSessionFromCtx(ctx);
        const role = (session?.user as { role?: string } | undefined)?.role;
        const age = session ? Date.now() - new Date(session.session.createdAt).getTime() : Infinity;
        if (role !== "admin" || !(age >= 0 && age <= FRESH_AUTH_SECONDS * 1000)) {
          throw new APIError("FORBIDDEN", { message: "Connect single sign-on from /me, on a fresh sign-in." });
        }
        // Once is enough. A second link would only re-attach the same
        // identity — and Better Auth's re-link path writes the provider's
        // tokens onto the row (the account update hook strips them as well).
        if (oidc && (await db.account.count({ where: { userId: session!.user.id, ...currentIssuerAccounts(oidc.issuer) } })) > 0) {
          throw new APIError("CONFLICT", { message: "Single sign-on is already connected." });
        }
      }

      if (!oidc || body.provider !== OIDC_PROVIDER_ID) return;

      // The discovery document as it stands now, checked: its issuer is the
      // configured one and nothing in it is plain HTTP behind an https issuer.
      // And the provider the plugin built was built from one that named the
      // same issuer — when it has built one: after a failed start-up
      // discovery the plugin builds it in its own hook, which runs after this
      // one. Either way the ID token's `iss` is held to OIDC_ISSUER in
      // `ssoProfile`, after the plugin has held it to the document's issuer,
      // so no sign-in completes through a provider built from another's.
      const discovery = await currentDiscovery(oidc);
      const built = (ctx.context.socialProviders as Array<{ id: string; issuer?: string }>).find(
        (p) => p.id === OIDC_PROVIDER_ID,
      );
      const problems = discovery.ok ? [] : discovery.problems;
      if (built?.issuer !== undefined && !sameIssuer(built.issuer, oidc.issuer)) {
        problems.push(`the provider was set up from a document naming the issuer ${JSON.stringify(built.issuer)}`);
      }
      if (problems.length) {
        ctx.context.logger.error(`single sign-on refused to start: ${problems.join("; ")}`);
        throw new APIError("SERVICE_UNAVAILABLE", { message: "Single sign-on is not available." });
      }

      // A re-authentication (src/app/reauth) asks the provider to make the
      // person sign in there again, whatever session it holds, and marks the
      // flow so the answer is held to that — see `ssoProfile`. The mark goes
      // in the server's half of the state; the parameters are set here rather
      // than trusted from the page. Connecting the provider is always one.
      if (linking || body.additionalData?.reauth === true) {
        await addOAuthServerContext({ [REAUTH_MARK]: true });
        return {
          context: {
            body: { ...body, additionalParams: { ...(body.additionalParams ?? {}), prompt: "login", max_age: "0" } },
          },
        };
      }
    }),
  },

  /**
   * A failed single sign-on comes back to the sign-in page, which knows how to
   * say what went wrong, rather than to Better Auth's own bare error page.
   */
  onAPIError: { errorURL: "/signin" },

  account: {
    /**
     * Somebody who already has an account here, signing in through the
     * provider for the first time, lands in *that* account — if, and only if,
     * the provider says it has verified the address and it matches.
     *
     * `trustedProviders` is left empty on purpose. A trusted provider is
     * linked on its say-so even when it has *not* verified the address, and
     * the whole of this rule is that it has.
     *
     * The printer owner's account is the exception, in `validateUserInfo`
     * below: it is never linked implicitly, so a provider that asserts the
     * owner's address does not thereby become the owner. The owner connects
     * the provider deliberately, from /me (`/link-social`, gated in
     * `hooks.before`).
     */
    accountLinking: { enabled: true, trustedProviders: [] },
    // Tokens are not refreshed on sign-in because none are kept — see the
    // account hooks below.
    updateAccountOnSignIn: false,
  },

  /**
   * Reset links are filed under a digest of their token rather than the token
   * itself, so a database reader sees no link they can put in a URL. The
   * digest is Better Auth's, and `prisma/reset-token.ts` reproduces it for
   * the two places that mint a row directly.
   */
  verification: { storeIdentifier: "hashed" },

  session: {
    expiresAt: undefined,

    /**
     * Twenty minutes of inactivity, not thirty days.
     *
     * `expiresIn` is an *idle* window rather than an absolute one: Better Auth
     * pushes `expiresAt` back out to `now + expiresIn` whenever a session is
     * used and the last push was more than `updateAge` ago. At the thirty days
     * this used to be, that meant a session never really expired — anybody who
     * opened the app monthly renewed it forever, on a cookie written into the
     * browser profile with `Max-Age=2592000`. "Thirty days" was the number in
     * the config; "indefinitely" was the behaviour.
     *
     * The machine this app runs on is a shared office desktop, so the threat
     * that matters is somebody sitting down after you — and against a captured
     * cookie the only thing that helps is how long it stays worth something.
     * Twenty minutes is that window. It also settles the cookie question by
     * itself: at `Max-Age=1200` the cookie is no longer something that outlives
     * the browser or turns up in a profile backup, so there is nothing to gain
     * from forcing a session cookie via `rememberMe: false` — which would in
     * fact be worse, because Better Auth reads that as a *fixed* 24-hour
     * session and skips the sliding refresh entirely.
     *
     * Twenty minutes is only humane because passkeys are here: conditional UI
     * signs a returning holder back in with no click. It does make the passkey
     * nudge load-bearing rather than decorative — anyone still on a password
     * types it several times a day, and that pressure is the point.
     */
    expiresIn: SESSION_IDLE_SECONDS,

    /**
     * Slide the window every minute rather than every day.
     *
     * `updateAge` is how stale the window may get before a request pushes it
     * out again, so it has to be far below `expiresIn` or the session expires
     * under somebody mid-task: at the old one-day setting a twenty-minute
     * window would be renewed long after it had already lapsed. A minute costs
     * one indexed UPDATE per active session per minute, and means the clock
     * only ever runs down when nobody is there.
     */
    updateAge: 60,

    /**
     * Left at a day, and deliberately not doing the job its name suggests.
     *
     * `freshAge` gates exactly two Better Auth endpoints: `/unlink-account`,
     * which `disabledAuthPaths` closes in every mode, and `/list-sessions`,
     * which lists only the caller's own. It is NOT the re-authentication
     * control for this app's own destructive actions; that is
     * `requireFreshAuth` in `src/lib/reauth.ts`, at five minutes. Kept at a day
     * so the library endpoint stays sane.
     */
    freshAge: 60 * 60 * 24,

    // Cookie caching is deliberately OFF.
    //
    // It stores a signed snapshot of the session in a second cookie and
    // trusts it without touching the database. That makes revocation lag by
    // the cache lifetime: after signing out, anyone holding the captured
    // cookie stays authenticated until the snapshot expires. On a shared
    // office machine that is precisely the case sign-out exists to cover —
    // and a DAST probe caught it doing exactly that (A07-logout).
    //
    // The same reasoning is why the session token stays an opaque row in
    // `session` rather than a self-describing JWT: a JWT is that snapshot with
    // a longer fuse, and it would put revocation — sign-out, access revoked, a
    // password reset — back on a delay measured in minutes.
    //
    // The cost of turning it off is one indexed lookup per request. For a
    // handful of users against Postgres on the same box, that is not a
    // trade worth making.
    cookieCache: { enabled: false },
  },

  advanced: {
    cookiePrefix: "ppp",
    useSecureCookies: isHttps,
    defaultCookieAttributes: {
      httpOnly: true,
      // "strict" would drop the cookie on the hop from a set-password link,
      // and the sign-in would appear to silently fail.
      sameSite: "lax",
      path: "/",
      secure: isHttps,
    },
  },

  rateLimit: {
    enabled: true,
    window: 60,
    max: 60,
    storage: "database",
    /**
     * A password is guessable in a way a link in an inbox never was, so the
     * paths that take one are capped well below the blanket rule.
     *
     * Ten a minute rather than three, for the same reason the invite limit is
     * ten: an office shares one NAT address, and a limit tuned for a single
     * user locks out the colleague at the next desk. Ten per minute still
     * puts online guessing several thousand years away from a ten-character
     * password, which is the number that matters.
     */
    customRules: {
      "/sign-in/username": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 10 },
      "/reset-password": { window: 60, max: 10 },
      // Would otherwise be a free oracle for "who is already here".
      "/is-username-available": { window: 60, max: 20 },
    },
  },

  user: {
    additionalFields: {
      // `input: false` keeps all three off the wire — a client cannot post
      // `role: "admin"` at sign-up. They are set server-side in the
      // `user.create.before` hook below, from the invite row.
      initials: { type: "string", required: false, input: false },
      role: { type: "string", required: false, input: false, defaultValue: "client" },
      invitedById: { type: "string", required: false, input: false },
    },

    /**
     * The invite-only gate.
     *
     * Called before any identity is provisioned, by every authentication
     * method — password sign-up and passkey today, whatever gets added
     * tomorrow. Better Auth runs it from `internalAdapter.createUser`, which
     * `/sign-up/email` goes through with `{ method: "email-password" }`, so
     * adding passwords did not move this rule or add a second copy of it.
     *
     * Two conditions, and the second is the one that was missing. A pending
     * invitation for the address is necessary and was once treated as
     * sufficient — but `/sign-up/email` answers anybody, so an address alone
     * let whoever knew it register the account without the link. The request
     * must also be the redemption of that link: `acceptInvite` checks the
     * token and wraps the sign-up in `claimingInvite`, and nothing a caller
     * sends can stand in for that. See `claimingInvite` in src/lib/invites.ts.
     *
     * Both refusals answer identically. Saying "there is an invitation for
     * that address, you just lack the link" would turn the endpoint into a way
     * to ask who has been invited. The trail keeps them apart instead.
     */
    async validateUserInfo({ user, source }, context) {
      if (source.action === "link-account") return linkRule(String(user.id ?? ""), source, context);
      if (source.action !== "create-user") return;

      const email = user.email ? normalizeEmail(user.email) : "";
      if (!email) {
        return { error: "invalid_request", errorDescription: "No email address." };
      }

      const invited = Boolean(await pendingInviteFor(email));
      const viaOidc = source.method === "oauth" && source.oauth?.providerId === OIDC_PROVIDER_ID;
      const verdict = mayProvision({
        invited,
        claimingLink: isClaimingInvite(email),
        viaOidc,
        // Exactly `true`. `mapProfileToUser` below already reduces the claim
        // to a boolean; this is the belt to that braces.
        emailVerifiedByProvider: viaOidc && user.emailVerified === true,
        oidcSignup: oidc?.signup ?? null,
      });
      if (!verdict.ok) {
        // Worth a trail entry: repeated rejections for the same address are
        // the shape of someone probing for a way in — and `no_link` against an
        // address that *is* invited is the shape of someone who knows who was.
        await record({
          action: "invite.rejected",
          subject: email,
          detail: { reason: verdict.reason, ...(viaOidc ? { via: "oidc" } : {}) },
        });
        // One refusal has its own answer. An address the provider has not
        // verified is refused before anything is looked up about it, so saying
        // so tells nobody who has been invited — and it is the one of these
        // the person at the keyboard can go and fix.
        if (verdict.reason === "unverified_email") {
          return {
            error: "email_not_verified",
            errorDescription: "Your sign-on provider has not verified that address.",
          };
        }
        return {
          error: "invite_required",
          errorDescription:
            "Pretty Please Print is invite-only. Ask the printer owner for a link.",
        };
      }
    },
  },

  databaseHooks: {
    user: {
      create: {
        /**
         * Stamp the fields the invite decided on. Reading them here rather
         * than trusting the request body is what makes `role` unspoofable.
         */
        async before(user) {
          const email = normalizeEmail(user.email);
          const invite = await pendingInviteFor(email);
          const name = (user.name || invite?.name || email.split("@")[0]!).trim();

          return {
            data: {
              ...user,
              email,
              name,
              initials: initialsFor(name),
              role: invite?.role ?? "client",
              invitedById: invite?.invitedById ?? null,
              // Registration only happens off a link sent to this address,
              // so the address is verified by construction.
              emailVerified: true,
            },
          };
        },

        /** Burn the invite so the link cannot mint a second account. */
        async after(user) {
          await consumeInvitesFor(user.email);
          await record({
            action: "invite.accepted",
            actor: { id: user.id, email: user.email },
            subject: user.email,
            detail: { name: user.name },
          });
        },
      },
    },

    account: {
      create: {
        /**
         * Keep none of the provider's tokens.
         *
         * Better Auth stores the access, refresh and ID token it was handed.
         * This app never calls the provider on anybody's behalf — the sign-in
         * is the whole of the relationship — so they would be credentials for
         * somebody else's system, sitting in this database for no reason. The
         * row keeps what it needs: which provider, and which subject there.
         */
        async before(account) {
          if (account.providerId !== OIDC_PROVIDER_ID) return;
          return {
            data: {
              ...account,
              accessToken: null,
              refreshToken: null,
              idToken: null,
              accessTokenExpiresAt: null,
              refreshTokenExpiresAt: null,
            },
          };
        },

        /**
         * An identity at the provider now opens this account. For somebody who
         * already had a password that is a new way in, added without anyone
         * here pressing a button — exactly the kind of change the trail is for.
         */
        async after(account) {
          if (account.providerId !== OIDC_PROVIDER_ID) return;
          const user = await db.user.findUnique({
            where: { id: account.userId },
            select: { id: true, email: true, role: true },
          });
          if (!user) return;
          // Connected from /me runs through `/link-social`, whose state names
          // the account; the automatic link at first sign-in has none.
          const state = await getOAuthState();
          await record({
            action: "auth.sso_linked",
            actor: user,
            subject: user.email,
            detail: { provider: oidc?.issuer ?? null, role: user.role, how: state?.link ? "connected" : "automatic" },
          });
        },
      },
      update: {
        /**
         * And none on an update either. Better Auth's link path, for an
         * identity that is already attached, writes the tokens it was handed
         * onto the existing row rather than creating one — which the create
         * hook above never sees.
         */
        async before(account) {
          if (!("accessToken" in account || "refreshToken" in account || "idToken" in account)) return;
          return {
            data: {
              ...account,
              ...("accessToken" in account ? { accessToken: null } : {}),
              ...("refreshToken" in account ? { refreshToken: null } : {}),
              ...("idToken" in account ? { idToken: null } : {}),
              ...("accessTokenExpiresAt" in account ? { accessTokenExpiresAt: null } : {}),
              ...("refreshTokenExpiresAt" in account ? { refreshTokenExpiresAt: null } : {}),
            },
          };
        },
      },
    },

    session: {
      create: {
        /**
         * A session opened through the provider dates from when the person
         * last authenticated *there* (its `auth_time`), not from when this row
         * was written — which is what makes `/reauth`'s "is this sign-in
         * recent?" mean somebody typed something recently, rather than that a
         * provider waved a held session through. See `ssoAuthenticatedAt`.
         */
        async before(session) {
          const at = ssoRequest()?.authenticatedAt;
          if (!at) return;
          return { data: { ...session, createdAt: at } };
        },
        async after(session) {
          const user = await db.user.findUnique({
            where: { id: session.userId },
            select: { id: true, email: true },
          });
          if (user) {
            await record({ action: "auth.signed_in", actor: user, subject: user.email });
          }
        },
      },
      delete: {
        async after(session) {
          const user = await db.user.findUnique({
            where: { id: session.userId },
            select: { id: true, email: true },
          });
          if (user) {
            await record({ action: "auth.signed_out", actor: user, subject: user.email });
          }
        },
      },
    },
  },

  plugins: [
    username({
      minUsernameLength: USERNAME_MIN,
      maxUsernameLength: USERNAME_MAX,
      usernameValidator: (value) => USERNAME_PATTERN.test(value),
      // `validationOrder` is left at the default (pre-normalization), which is
      // the only setting under which sign-up and sign-in agree: sign-in
      // normalises *before* validating, so a case-sensitive rule applied after
      // normalisation would accept `Ayla_B` at registration and then refuse it
      // at the door. The validator above is case-insensitive for the same
      // reason — the plugin folds the value either way.
    }),

    /**
     * Refuse a password that is already in a breach corpus.
     *
     * The single highest-value password control there is: a ten-character
     * password is only strong if it is not one of the several hundred million
     * that have already been published. Checked by k-anonymity — five
     * characters of a SHA-1 prefix leave the machine, never the password.
     *
     * It fails closed. If api.pwnedpasswords.com cannot be reached, setting a
     * password fails rather than quietly skipping the check, which is the
     * right way round: the alternative is a control that silently is not one.
     * Registration and reset are the only paths that set a password, so an
     * outage cannot lock out anybody who already has one.
     *
     * `HIBP_DISABLED=true` is the escape hatch for a deployment with no
     * outbound internet at all — a NAS on an isolated VLAN, say. Failing
     * closed there would mean nobody could ever register, which is worse than
     * losing the check. It is off by default and should stay that way.
     */
    haveIBeenPwned({
      enabled: process.env.HIBP_DISABLED !== "true",
      customPasswordCompromisedMessage:
        "That password appears in a known breach. Pick another — length beats cleverness.",
    }),

    /**
     * Single sign-on, through one OpenID Connect provider the host names.
     *
     * Always registered, with no providers when it is off: a plugin list whose
     * shape depends on the environment would make `auth.api` a different type
     * on every deployment. Off, it adds nothing — and `/sign-in/social` is in
     * `disabledPaths` besides.
     *
     * Discovery rather than typed-out endpoints, so the keys come from the
     * provider's own document and the ID token is checked against them:
     * signature, issuer, audience, expiry, and the nonce that binds it to the
     * request that asked. `requireIdTokenVerification` makes that a condition
     * of the provider existing at all — without it, a discovery document that
     * failed to load would quietly downgrade sign-in to *decoding* a token
     * nobody had verified. PKCE is on by default and left on.
     */
    genericOAuth({
      config: oidc
        ? [
            {
              providerId: OIDC_PROVIDER_ID,
              // Better Auth's own label, never shown: the screens name the
              // provider themselves.
              name: oidc.name ?? OIDC_PROVIDER_ID,
              discoveryUrl: oidc.discoveryUrl,
              clientId: oidc.clientId,
              clientSecret: oidc.clientSecret,
              scopes: ["openid", "email", "profile"],
              prompt: oidc.prompt,
              requireIdTokenVerification: true,
              /**
               * Filed under issuer and subject, not the subject alone: see
               * `ssoAccountId`.
               */
              accountSubject: ({ profile }) => (profile.sub ? ssoAccountId(oidc.issuer, String(profile.sub)) : ""),
              /** The checks this app adds to the profile step: `ssoProfile`. */
              getUserInfo: (tokens) => ssoProfile(tokens, oidc, (m) => console.error(`[auth] ${m}`)),
              /**
               * Three claims, and nothing else from the provider reaches a
               * user row. In particular not a role: who the printer owner is
               * was decided by the seed, and what an invitee may do by their
               * invitation. Nor a picture: the plugin would copy `picture`
               * into `image`, a URL of the provider's choosing that nothing
               * here shows and that a browser would be sent to fetch.
               *
               * `email_verified` must be the boolean `true`. Providers have
               * been seen sending the string "false", which is truthy.
               */
              mapProfileToUser: (profile) => ({
                email: typeof profile.email === "string" ? profile.email : undefined,
                emailVerified: profile.email_verified === true,
                name:
                  (typeof profile.name === "string" && profile.name.trim()) ||
                  (typeof profile.preferred_username === "string" && profile.preferred_username.trim()) ||
                  undefined,
                image: undefined,
              }),
            },
          ]
        : [],
    }),

    passkey({
      rpID: process.env.PASSKEY_RP_ID ?? "localhost",
      rpName: process.env.PASSKEY_RP_NAME ?? "Pretty Please Print",
      origin: baseURL,
      authenticatorSelection: {
        // Discoverable credentials let someone sign in without typing a
        // username at all. "preferred" rather than "required" so older
        // security keys still work.
        residentKey: "preferred",
        userVerification: "preferred",
      },
    }),

    admin({
      defaultRole: "client",
      adminRoles: ["admin"],
    }),

    /**
     * Let a caller hold the session token in an `Authorization: Bearer`
     * header instead of a cookie.
     *
     * This exists for the API console at `/docs` and for anything driving the
     * app from a terminal: a cookie jar is awkward in `curl` and impossible in
     * most one-liners, and the alternative people reach for otherwise is
     * pasting a session cookie out of devtools, which is worse.
     *
     * Three things are worth being clear-eyed about, because a second way in
     * is a second thing to get wrong:
     *
     *   - **It is the session token, not a new kind of credential.** There is
     *     no separate API-key table, no separate lifetime and no separate
     *     revocation path. Signing out, revoking access or a password reset
     *     kills the bearer token at the same instant it kills the cookie,
     *     because they are the same row in `session`. Suspension is caught by
     *     `currentUser()` either way.
     *   - **It is not `SameSite`-protected**, which is the one property the
     *     cookie has that this does not. It does not need to be: a page on
     *     another origin cannot attach an `Authorization` header to a
     *     cross-site request without a CORS preflight, and this app serves no
     *     CORS headers, so the preflight fails. Writes are Origin-checked as
     *     well — see `src/lib/api.ts`.
     *   - **It ends up in shell history and in logs** in a way a cookie does
     *     not. `docs/api.md` says so, and says to use a fresh sign-in for a
     *     script rather than the token from the browser you are sitting in.
     *
     * `requireSignature` is left at its default. Better Auth verifies the
     * token's HMAC either way — the option only decides whether an unsigned
     * token may be re-signed on the way in, and the token this app hands out
     * in `set-auth-token` is already the signed one.
     */
    bearer(),

    /**
     * Describes every endpoint above, for `src/lib/openapi.ts` to fold into
     * the app's own document.
     *
     * Only ever called in process, as `auth.api.generateOpenAPISchema()`. The
     * two HTTP endpoints the plugin comes with are both closed:
     *
     *   - `/api/auth/reference` would load Scalar from `cdn.jsdelivr.net`,
     *     which `script-src 'self'` refuses — the page would render an empty
     *     frame with nothing to say why. `disableDefaultReference` turns it
     *     off; the console at `/docs` serves its own copy of Swagger UI from
     *     this origin instead.
     *   - `/api/auth/open-api/generate-schema` answers **200 to anybody**,
     *     with no session. Nothing here calls it over HTTP, and handing a
     *     stranger the list of which auth plugins this deployment runs is the
     *     kind of thing `/api/health` is deliberately terse about. The plugin
     *     offers no way to unmount it, so middleware answers 404 for it.
     */
    openAPI({ disableDefaultReference: true }),

    // Must stay last: it copies Set-Cookie out of Better Auth responses into
    // the Next.js cookie store so server actions can establish a session.
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
