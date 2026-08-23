import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins/admin";
import { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned";
import { username } from "better-auth/plugins/username";
import { passkey } from "@better-auth/passkey";

import { db } from "@/lib/db";
import { normalizeEmail, pendingInviteFor, consumeInvitesFor } from "@/lib/invites";
import { initialsFor } from "@/lib/tokens";
import { isBuildPhase } from "@/lib/runtime";
import { record } from "@/lib/audit";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
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

export const auth = betterAuth({
  appName: "Pretty Please Print",
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(db, { provider: "postgresql" }),

  /**
   * Username and password is how people get in.
   *
   * `requireEmailVerification` stays off: the address was verified by
   * construction. The only way to reach sign-up at all is through an invite
   * link that was delivered to that mailbox, and the invite gate below
   * refuses anything else.
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
   * Reset links are filed under a digest of their token rather than the token
   * itself, so a database reader sees no link they can put in a URL. The
   * digest is Better Auth's, and `prisma/reset-token.ts` reproduces it for
   * the two places that mint a row directly.
   */
  verification: { storeIdentifier: "hashed" },

  session: {
    expiresAt: undefined,
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // slide the window at most once a day
    freshAge: 60 * 60 * 24, // "recent login" window for sensitive actions
    // Cookie caching is deliberately OFF.
    //
    // It stores a signed snapshot of the session in a second cookie and
    // trusts it without touching the database. That makes revocation lag by
    // the cache lifetime: after signing out, anyone holding the captured
    // cookie stays authenticated until the snapshot expires. On a shared
    // office machine that is precisely the case sign-out exists to cover —
    // and a DAST probe caught it doing exactly that (A07-logout).
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
     * No pending invite, no account.
     */
    async validateUserInfo({ user, source }) {
      if (source.action !== "create-user") return;

      const email = user.email ? normalizeEmail(user.email) : "";
      if (!email) {
        return { error: "invalid_request", errorDescription: "No email address." };
      }

      if (!(await pendingInviteFor(email))) {
        // Worth a trail entry: repeated rejections for the same address are
        // the shape of someone probing for a way in.
        await record({ action: "invite.rejected", subject: email });
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

    session: {
      create: {
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

    // Must stay last: it copies Set-Cookie out of Better Auth responses into
    // the Next.js cookie store so server actions can establish a session.
    nextCookies(),
  ],
});

export type Session = typeof auth.$Infer.Session;
