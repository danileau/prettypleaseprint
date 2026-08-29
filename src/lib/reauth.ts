import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { FRESH_AUTH_SECONDS } from "@/lib/auth-rules";

/**
 * Re-authentication for the actions that move access around.
 *
 * The session window is twenty idle minutes, which limits how long a captured
 * cookie is worth anything but does not stop it being worth something *now*.
 * The things worth protecting from a stolen twenty minutes are the ones that
 * outlive it: an invitation mints a whole new account, a reset link is the
 * ability to become somebody else, and revoking access locks a colleague out.
 * So those ask for the passkey or the password again, which is the one control
 * on the list a thief cannot satisfy with a copied cookie.
 *
 * **Freshness is the age of the session itself.** Better Auth 1.7.1 has no
 * "prove it is you" primitive — `/passkey/verify-authentication` and
 * `/sign-in/username` both mint a *new* session rather than annotating the one
 * you hold — so re-authenticating means signing in again, and a session that
 * was created moments ago is exactly the evidence we are looking for. It also
 * means a normal sign-in is fresh for its first five minutes, which is right:
 * somebody who just typed their password should not be asked for it twice.
 *
 * The cost of doing it this way is one superseded session row per re-auth.
 * That was the deciding trade when the window was thirty days; at twenty idle
 * minutes the orphan is gone before anyone would notice it, which is what
 * makes this the cheap option rather than hand-rolling WebAuthn verification
 * against the `passkey` table.
 */

/** Seconds since this session was created, or null if there is no session. */
export async function authAgeSeconds(): Promise<number | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  const createdAt = session?.session?.createdAt;
  if (!createdAt) return null;

  const ms = Date.now() - new Date(createdAt).getTime();
  // A clock that disagrees with the database should not mint freshness out of
  // nowhere, so a negative age is treated as "no idea" rather than "brand new".
  return ms < 0 ? null : Math.floor(ms / 1000);
}

/** Did this session begin recently enough to stand in for a re-auth? */
export async function isFreshAuth(): Promise<boolean> {
  const age = await authAgeSeconds();
  // Fails closed: no session, or an age we cannot read, is not fresh.
  return age !== null && age <= FRESH_AUTH_SECONDS;
}

/**
 * Gate for an action that grants, transfers or withdraws access.
 *
 * Sends the caller to `/reauth` when their sign-in is too old, and returns
 * only when it is recent enough. `returnTo` is where they land afterwards —
 * the screen they were on, not the action they were attempting, because the
 * form has to be filled in again anyway.
 */
export async function requireFreshAuth(returnTo: string): Promise<void> {
  if (await isFreshAuth()) return;
  redirect(`/reauth?next=${encodeURIComponent(returnTo)}`);
}
