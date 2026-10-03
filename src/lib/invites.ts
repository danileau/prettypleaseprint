import { AsyncLocalStorage } from "node:async_hooks";
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

// ---------------------------------------------------------------------------
// Claiming: the link, not the address, is what opens an account
// ---------------------------------------------------------------------------

/**
 * "This request is redeeming an invitation link for this address."
 *
 * The invite gate in src/lib/auth.ts used to ask one question — is there a
 * pending invitation for this e-mail address — and Better Auth's sign-up
 * endpoint is reachable by anyone. Put together, the *address* was the
 * credential: anybody who knew or guessed an invited address could post it to
 * `/api/auth/sign-up/email` with a password of their own and be handed the
 * account and a session, without ever seeing the link. The token in the link,
 * the thing that proves the mailbox, played no part.
 *
 * So the gate now asks a second question, and this is how it is answered. The
 * only code that may open an account is the code that has just checked a token
 * (`acceptInvite`), and it says so by running the sign-up inside
 * `claimingInvite`. The gate reads it back with `isClaimingInvite`. A request
 * that arrives at the endpoint by itself has no claim around it, and is
 * refused exactly as an address with no invitation is.
 *
 * AsyncLocalStorage rather than a field in the sign-up body, because a body is
 * the one thing the caller controls: this cannot be set from outside the
 * process. It hangs off `globalThis` so that two copies of this module — which
 * a bundler is free to make — still share one store.
 */
const CLAIM = Symbol.for("ppp.invite-claim");
type ClaimStore = AsyncLocalStorage<{ email: string }>;
const claims: ClaimStore = ((globalThis as Record<symbol, unknown>)[CLAIM] as ClaimStore | undefined) ??
  ((globalThis as Record<symbol, unknown>)[CLAIM] = new AsyncLocalStorage<{ email: string }>());

/** Run `fn` as the redemption of this invitation. Call it only after the token has been checked. */
export function claimingInvite<T>(invite: Pick<Invite, "email">, fn: () => Promise<T>): Promise<T> {
  return claims.run({ email: normalizeEmail(invite.email) }, fn);
}

/** Is the current request redeeming an invitation for exactly this address? */
export function isClaimingInvite(email: string): boolean {
  return claims.getStore()?.email === normalizeEmail(email);
}

export { mailConfigured };

export const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
