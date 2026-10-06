import type { BetterAuthPlugin, GenericEndpointContext, User } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";

import { DEVICE_MARKER_COOKIE, DEVICE_SESSION_SECONDS } from "@/lib/auth-rules";
import { deviceMarkerFor } from "@/lib/device-marker";

/**
 * How a member gets in without a password: the device is the credential.
 *
 * Two endpoints, both **server-only** — `createAuthEndpoint.serverOnly` keeps
 * them off the HTTP router entirely, so `/api/auth/*` grows nothing a stranger
 * could post to. They are reached through `auth.api.*` from exactly two server
 * actions, each of which has already checked a single-use token:
 *
 *   - `registerMemberDevice` — the invitation page. Creates the account
 *     through Better Auth's own `createUser`, so the invite-only gate in
 *     `user.validateUserInfo` and the `user.create.before` stamping of role,
 *     initials and inviter run exactly as they do for any other sign-up. The
 *     caller must already be inside `claimingInvite`.
 *   - `signInMemberDevice` — a device link the printer owner minted for an
 *     existing member, for a new phone or a browser whose cookies were wiped.
 *
 * Both end in the same place: a session row that lasts four hundred days, and
 * a cookie that says so. Better Auth's admin plugin still refuses a session
 * for a suspended account here, because that check is a `session.create`
 * database hook rather than something the sign-in routes do for themselves.
 *
 * Members only. A device session for the printer owner would be a way round
 * the twenty-minute window and the re-authentication gate that protect the
 * admin surface, so both endpoints refuse anything that is not a client.
 */
async function startDeviceSession(ctx: GenericEndpointContext, user: User & { role?: unknown }) {
  if (user.role !== "client") {
    throw new APIError("FORBIDDEN", {
      code: "members_only",
      message: "Device sign-in is for invited members only.",
    });
  }

  const session = await ctx.context.internalAdapter.createSession(
    user.id,
    false,
    { expiresAt: new Date(Date.now() + DEVICE_SESSION_SECONDS * 1000) },
    true,
  );
  if (!session) {
    throw new APIError("INTERNAL_SERVER_ERROR", { message: "No session was created." });
  }

  await setSessionCookie(ctx, { session, user }, false, { maxAge: DEVICE_SESSION_SECONDS });

  // Lets middleware tell this cookie apart from a twenty-minute one. Not a
  // secret, and not an authority — see DEVICE_MARKER_COOKIE.
  const attrs = ctx.context.authCookies.sessionToken.attributes;
  ctx.setCookie(DEVICE_MARKER_COOKIE, await deviceMarkerFor(session.token), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: attrs.secure,
    maxAge: DEVICE_SESSION_SECONDS,
  });

  return session;
}

export function deviceSessions() {
  return {
    id: "device-sessions",
    endpoints: {
      registerMemberDevice: createAuthEndpoint.serverOnly(
        {
          method: "POST",
          body: z.object({
            email: z.string().min(1),
            name: z.string().trim().min(1).max(80),
          }),
        },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.createUser(
            { email: ctx.body.email, name: ctx.body.name },
            { method: "device-link" },
          );
          await startDeviceSession(ctx, user);
          return ctx.json({ userId: user.id });
        },
      ),

      signInMemberDevice: createAuthEndpoint.serverOnly(
        {
          method: "POST",
          body: z.object({ userId: z.string().min(1) }),
        },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
          if (!user) {
            throw new APIError("NOT_FOUND", { message: "No such member." });
          }
          await startDeviceSession(ctx, user);
          return ctx.json({ userId: user.id });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
