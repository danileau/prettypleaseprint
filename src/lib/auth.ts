import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins/magic-link";
import { admin } from "better-auth/plugins/admin";
import { passkey } from "@better-auth/passkey";

import { db } from "@/lib/db";
import { magicLinkEmail, sendMail } from "@/lib/email";
import { consumeInvitesFor, normalizeEmail, pendingInviteFor } from "@/lib/invites";
import { initialsFor } from "@/lib/tokens";
import { isBuildPhase } from "@/lib/runtime";
import { record } from "@/lib/audit";

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

const MAGIC_LINK_TTL_MINUTES = 10;

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
        "Session cookies carry the Secure flag and magic links are sent by " +
        "email; neither is safe to serve over plain HTTP.",
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
 * ---------------------------------------------------------------------------
 * Direct grant, used only by invite acceptance.
 * ---------------------------------------------------------------------------
 * Someone who followed an invite link has already proved they control the
 * mailbox — the token was delivered there and nowhere else. Making them read a
 * *second* email to finish signing up adds a hop without adding assurance.
 *
 * So invite acceptance calls `issueInviteSignInUrl()`, which runs the normal
 * magic-link issuance inside this store. `sendMagicLink` sees the store, hands
 * the URL back in-process instead of mailing it, and the route redirects the
 * browser through it. Every check Better Auth performs on a magic link still
 * runs — the link is simply redeemed immediately rather than days later, and
 * it never leaves the server.
 */
const directGrant = new AsyncLocalStorage<{ url?: string }>();

export const auth = betterAuth({
  appName: "Pretty Please Print",
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(db, { provider: "postgresql" }),

  // There is no password anywhere in this app. Nothing to phish, nothing to
  // reuse, nothing to leak.
  emailAndPassword: { enabled: false },

  trustedOrigins: [baseURL],

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
      sameSite: "lax", // "strict" would break the magic-link landing
      path: "/",
      secure: isHttps,
    },
  },

  // Blanket limiter; the magic-link plugin adds a tighter one of its own.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 60,
    storage: "database",
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
     * method — today magic link and passkey, tomorrow whatever gets added.
     * No pending invite, no account. This is the one place that decides who
     * is allowed to exist, which is why it lives here and not in a route.
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
              // Provisioning only happens off a link sent to this address,
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
    magicLink({
      expiresIn: 60 * MAGIC_LINK_TTL_MINUTES,
      // Digest at rest: a database reader sees hashes, not usable links.
      storeToken: "hashed",
      // Per IP. Deliberately not tighter: an office sits behind one NAT
      // address, so a limit of 3 would refuse the fourth colleague to claim
      // an invite in the same minute. Ten still stops mail-bombing an inbox,
      // and the responses are identical either way, so this is not an
      // enumeration oracle to grind against.
      rateLimit: { window: 60, max: 10 },
      async sendMagicLink({ email, url }) {
        const box = directGrant.getStore();
        if (box) {
          box.url = url;
          return;
        }
        await sendMail(
          magicLinkEmail({
            to: email,
            url,
            expiresInMinutes: MAGIC_LINK_TTL_MINUTES,
          }),
        );
      },
    }),

    passkey({
      rpID: process.env.PASSKEY_RP_ID ?? "localhost",
      rpName: process.env.PASSKEY_RP_NAME ?? "Pretty Please Print",
      origin: baseURL,
      authenticatorSelection: {
        // Discoverable credentials let someone sign in without typing an
        // address at all. "preferred" rather than "required" so older
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

/**
 * Issue a magic-link URL without mailing it.
 *
 * Two callers, both deliberate:
 *   - invite acceptance, which already proved control of the mailbox
 *   - the admin re-issuing access for someone who lost their passkey and
 *     cannot receive mail
 *
 * The second is effectively impersonation: the link signs the browser in AS
 * that person. It is allowed because it grants the printer owner nothing they
 * did not already have — they own the machine and the database — and an
 * audited action is strictly better than a quiet `UPDATE`. It is recorded
 * loudly for that reason.
 */
export async function issueSignInUrl(
  email: string,
  headers: Headers,
  callbackURL: string,
): Promise<string> {
  const box: { url?: string } = {};

  await directGrant.run(box, () =>
    auth.api.signInMagicLink({
      body: { email: normalizeEmail(email), callbackURL },
      headers,
    }),
  );

  if (!box.url) {
    throw new Error("No sign-in link was issued.");
  }
  return box.url;
}
