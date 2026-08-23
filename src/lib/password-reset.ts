// No `server-only` guard here, deliberately: the verification suites import
// this module under tsx to mint a link the same way the app does, and that
// package only resolves inside a Next build. `@/lib/invites` is server-side
// for the same reasons and carries none either.
import { db } from "@/lib/db";
import { appUrl } from "@/lib/invites";
import {
  RESET_TTL_MINUTES,
  newResetToken,
  resetIdentifier,
} from "../../prisma/reset-token";

export { RESET_TTL_MINUTES };

/**
 * Mint a single-use link that lets someone set a password.
 *
 * Used for two things that are the same mechanism wearing different words:
 * the admin resetting a member's forgotten password, and the printer owner
 * establishing their own for the first time (`prisma/seed.ts`).
 *
 * The row it writes is Better Auth's, so redeeming it goes through Better
 * Auth's `/reset-password` endpoint with all of its checks — expiry, single
 * use, length, and the breach lookup. Nothing here re-implements any of that;
 * this only decides *when* a token exists.
 *
 * Note what the link does NOT do: it does not sign anybody in. Whoever holds
 * it can set a password and must then use it, which is the whole difference
 * between this and the sign-in link it replaces.
 */
export async function issuePasswordSetupUrl(userId: string): Promise<string> {
  const token = newResetToken();

  await db.verification.create({
    data: {
      identifier: resetIdentifier(token),
      value: userId,
      expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
    },
  });

  return appUrl(`/set-password?token=${encodeURIComponent(token)}`);
}

/**
 * Throw away every outstanding reset link for a user.
 *
 * Called before minting a new one so "reset it again" cannot leave two live
 * links in circulation — the older one is usually the one that leaked.
 *
 * Matching on `value` rather than `identifier` because the identifier is a
 * digest we cannot search by prefix. It is exact enough: a reset row's value
 * is the bare user id, and the only other rows in this table are WebAuthn
 * challenges, whose value is always a JSON object.
 */
export async function revokePasswordSetupLinks(userId: string): Promise<void> {
  await db.verification.deleteMany({ where: { value: userId } });
}

/**
 * What a set-password link resolves to, or null if it resolves to nothing.
 *
 * Looked up through the same digest the row was filed under, so the raw token
 * is never compared against anything stored. `expiresAt` comes back because
 * redeeming the link deletes the row and the caller may need to put it back —
 * see `restorePasswordSetupLink`.
 */
export async function readResetToken(token: string) {
  const row = await db.verification.findFirst({
    where: { identifier: resetIdentifier(token) },
    orderBy: { createdAt: "desc" },
    select: { value: true, expiresAt: true },
  });
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;

  const user = await db.user.findUnique({
    where: { id: row.value },
    select: { id: true, email: true, name: true, username: true },
  });
  return user ? { user, expiresAt: row.expiresAt } : null;
}

/**
 * Put a redeemed link back.
 *
 * Better Auth consumes the token before it hashes the new password, so a
 * password refused by the breach check burns the link on its way out and the
 * person is told to go and ask for another — over a password they were about
 * to correct. Restoring the row makes the link spent when a password is
 * actually set, which is what "single use" was ever meant to mean.
 *
 * The expiry is the original one, so this extends nothing.
 */
export async function restorePasswordSetupLink(
  token: string,
  userId: string,
  expiresAt: Date,
): Promise<void> {
  const identifier = resetIdentifier(token);
  const stillThere = await db.verification.findFirst({
    where: { identifier },
    select: { id: true },
  });
  if (stillThere) return;

  await db.verification.create({ data: { identifier, value: userId, expiresAt } });
}
