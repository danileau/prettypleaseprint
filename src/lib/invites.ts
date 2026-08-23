import { Prisma, type Invite, type Role } from "@prisma/client";
import { db } from "@/lib/db";
import { generateToken, hashToken } from "@/lib/tokens";
import { inviteEmail, mailConfigured, sendMail } from "@/lib/email";

export const INVITE_TTL_DAYS = 7;

/** Emails are compared case-insensitively everywhere; store them folded. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function appUrl(path = "/"): string {
  const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  return new URL(path, base).toString();
}

export function inviteUrl(token: string): string {
  return appUrl(`/invite/${encodeURIComponent(token)}`);
}

export type InviteRejection =
  | "not_found"
  | "expired"
  | "revoked"
  | "already_accepted";

export type InviteCheck =
  | { ok: true; invite: Invite }
  | { ok: false; reason: InviteRejection };

/**
 * Resolve a raw token from an invite link.
 *
 * The lookup is by digest, so the raw token is never compared against
 * anything stored — a leaked database gives an attacker hashes and nothing
 * they can put in a URL.
 */
export async function checkInviteToken(token: string): Promise<InviteCheck> {
  if (!token) return { ok: false, reason: "not_found" };

  const invite = await db.invite.findUnique({
    where: { tokenHash: hashToken(token) },
  });

  if (!invite) return { ok: false, reason: "not_found" };
  if (invite.revokedAt) return { ok: false, reason: "revoked" };
  if (invite.acceptedAt) return { ok: false, reason: "already_accepted" };
  if (invite.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, invite };
}

/**
 * The pending invite for an address, if any. This is the single source of
 * truth for "is this person allowed to exist", consulted by the
 * `user.validateUserInfo` gate in `src/lib/auth.ts`.
 */
export function pendingInviteFor(email: string) {
  return db.invite.findFirst({
    where: {
      email: normalizeEmail(email),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
  });
}

export class InviteError extends Error {
  constructor(
    message: string,
    readonly code: "already_a_member" | "already_invited" | "not_found",
  ) {
    super(message);
  }
}

/**
 * What the caller gets back. `handoverUrl` is present only when the link could
 * not be delivered, i.e. no mail transport is configured.
 *
 * When mail works, the raw token is still withheld: it exists only inside the
 * message, so not even the admin who sent it can replay the link. That
 * property is worth keeping wherever it can be kept — it just cannot be kept
 * when there is nowhere to send the message, and refusing to work at all was
 * the worse answer.
 */
export type CreatedInvite = { invite: Invite; handoverUrl?: string };

export async function createInvite(opts: {
  email: string;
  name?: string | null;
  role?: Role;
  invitedById: string;
}): Promise<CreatedInvite> {
  const email = normalizeEmail(opts.email);

  if (await db.user.findUnique({ where: { email } })) {
    throw new InviteError(`${email} already has an account.`, "already_a_member");
  }
  if (await pendingInviteFor(email)) {
    throw new InviteError(
      `${email} already has an invite that has not been used yet.`,
      "already_invited",
    );
  }

  const token = generateToken();
  const invite = await db.invite.create({
    data: {
      email,
      tokenHash: hashToken(token),
      name: opts.name?.trim() || null,
      role: opts.role ?? "client",
      invitedById: opts.invitedById,
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
    },
    include: { invitedBy: { select: { name: true } } },
  });

  const url = inviteUrl(token);
  const delivered = await sendMail(
    inviteEmail({
      to: email,
      url,
      inviterName: invite.invitedBy.name,
      expiresInDays: INVITE_TTL_DAYS,
    }),
  );

  return delivered ? { invite } : { invite, handoverUrl: url };
}

/**
 * Rotate the token, push the expiry out and send again. Rotating means an
 * older email that has since leaked stops working the moment a resend happens.
 */
export async function resendInvite(inviteId: string): Promise<CreatedInvite> {
  const existing = await db.invite.findUnique({
    where: { id: inviteId },
    include: { invitedBy: { select: { name: true } } },
  });
  if (!existing || existing.acceptedAt || existing.revokedAt) {
    throw new InviteError("That invite is no longer open.", "not_found");
  }

  const token = generateToken();
  const invite = await db.invite.update({
    where: { id: inviteId },
    data: {
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
      sentAt: new Date(),
    },
  });

  const url = inviteUrl(token);
  const delivered = await sendMail(
    inviteEmail({
      to: invite.email,
      url,
      inviterName: existing.invitedBy.name,
      expiresInDays: INVITE_TTL_DAYS,
    }),
  );

  return delivered ? { invite } : { invite, handoverUrl: url };
}

export async function revokeInvite(inviteId: string): Promise<void> {
  await db.invite.updateMany({
    where: { id: inviteId, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Burn every open invite for an address once its account exists.
 *
 * `updateMany` with `acceptedAt: null` in the filter makes this a single
 * conditional UPDATE, so two links raced against each other still only mark
 * the invite accepted once.
 */
export async function consumeInvitesFor(email: string): Promise<void> {
  await db.invite.updateMany({
    where: { email: normalizeEmail(email), acceptedAt: null, revokedAt: null },
    data: { acceptedAt: new Date() },
  });
}

/** Housekeeping: drop invites nobody used. Safe to call from a cron. */
export async function purgeStaleInvites(): Promise<number> {
  const { count } = await db.invite.deleteMany({
    where: {
      acceptedAt: null,
      expiresAt: { lt: new Date(Date.now() - 30 * 86_400_000) },
    },
  });
  return count;
}

export { mailConfigured };

export const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
