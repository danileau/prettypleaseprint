// No `server-only` guard, for the same reason `password-reset.ts` carries
// none: the verification suites import this under tsx to mint a link the way
// the app does.
import { createHash, randomBytes } from "node:crypto";

import { db } from "@/lib/db";
import { appUrl } from "@/lib/invites";
import { DEVICE_LINK_TTL_MINUTES } from "@/lib/auth-rules";

export { DEVICE_LINK_TTL_MINUTES };

/**
 * A single-use link that signs one more device in as an existing member.
 *
 * Members have no password, so this is what a new phone, a second computer or
 * a browser whose cookies were cleared needs. Only the printer owner mints
 * one, it works once, and it lasts half an hour.
 *
 * Unlike a set-password link this one **does** sign somebody in: whoever opens
 * it becomes that member on that device. That is the point of it, and the
 * reason it is short-lived, revoked whenever a newer one is minted, gated
 * behind re-authentication for the owner, and recorded in the audit trail
 * both when it is minted and when it is used.
 *
 * Stored in Better Auth's `verification` table like a reset link, under a
 * digest of the token so a database reader sees nothing they can put in a
 * URL — but with its own prefix on both columns, so Better Auth's
 * `/reset-password` cannot redeem one and `revokePasswordSetupLinks` does not
 * sweep one up.
 */
const VALUE_PREFIX = "device-link:";

function identifierFor(token: string): string {
  return createHash("sha256").update(`device-link:${token}`, "utf8").digest("base64url");
}

export async function issueDeviceLinkUrl(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.verification.create({
    data: {
      identifier: identifierFor(token),
      value: `${VALUE_PREFIX}${userId}`,
      expiresAt: new Date(Date.now() + DEVICE_LINK_TTL_MINUTES * 60_000),
    },
  });
  return appUrl(`/device/${encodeURIComponent(token)}`);
}

/** Throw away every outstanding device link for a member. */
export async function revokeDeviceLinks(userId: string): Promise<void> {
  await db.verification.deleteMany({ where: { value: `${VALUE_PREFIX}${userId}` } });
}

/** Who a device link would sign in as, or null if it is spent or unknown. */
export async function readDeviceLink(token: string) {
  const row = await db.verification.findFirst({
    where: { identifier: identifierFor(token), expiresAt: { gt: new Date() } },
    select: { id: true, value: true },
  });
  if (!row?.value.startsWith(VALUE_PREFIX)) return null;

  const user = await db.user.findUnique({
    where: { id: row.value.slice(VALUE_PREFIX.length) },
    select: { id: true, name: true, email: true, role: true, banned: true },
  });
  return user ? { rowId: row.id, user } : null;
}

/**
 * Spend a device link. Returns the member it was for, or null if somebody
 * else spent it first — the delete is the claim, so two tabs racing on the
 * same link cannot both win.
 */
export async function consumeDeviceLink(token: string) {
  const link = await readDeviceLink(token);
  if (!link) return null;
  const { count } = await db.verification.deleteMany({ where: { id: link.rowId } });
  return count === 1 ? link.user : null;
}
