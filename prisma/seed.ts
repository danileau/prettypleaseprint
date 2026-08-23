/**
 * Bootstraps the single admin — the printer owner.
 *
 * This is the one account that is not created by an invitation, because
 * somebody has to be able to send the first one. It is written straight
 * through Prisma rather than Better Auth: there is no invite to validate
 * against, only a row.
 *
 * The row alone cannot sign in — it has no password and no username. So when
 * the admin has no credential yet, the seed mints a single-use set-password
 * link and prints it. That link is the whole handover: whoever runs the deploy
 * reads it out of the container logs and uses it once.
 *
 * The password deliberately does NOT come from the environment. A password in
 * `.env.docker` is a password in `docker inspect`, in the shell history that
 * wrote the file, and in every backup of the host — and it would still be
 * sitting there, valid, months later. A link that expires in half an hour is
 * a smaller thing to leak.
 *
 * Idempotent: re-running it updates the name, and mints a new link only while
 * the admin still has no password. It never resets an existing one.
 */
import { PrismaClient } from "@prisma/client";

import { RESET_TTL_MINUTES, newResetToken, resetIdentifier } from "./reset-token";

const db = new PrismaClient();

// Mirrors src/lib/tokens.ts. Duplicated so the seed runs without the app's
// module graph (and its "server-only" imports).
function initialsFor(name: string): string {
  const first = name.trim().split(/\s+/).filter(Boolean)[0];
  if (!first) return "??";
  return [...first].slice(0, 2).join("").toUpperCase();
}

const appUrl = (path: string) =>
  new URL(path, process.env.BETTER_AUTH_URL ?? "http://localhost:3000").toString();

async function main() {
  const email = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const name = (process.env.ADMIN_NAME ?? "").trim();

  if (!email || !name) {
    throw new Error(
      "Set ADMIN_EMAIL and ADMIN_NAME in .env before seeding — they define " +
        "the printer owner.",
    );
  }

  const existingAdmin = await db.user.findFirst({ where: { role: "admin" } });

  if (existingAdmin && existingAdmin.email !== email) {
    throw new Error(
      `An admin already exists (${existingAdmin.email}). This app has exactly ` +
        `one. To hand the printer over, change that user's email instead of ` +
        `seeding a second admin — the database will reject it anyway.`,
    );
  }

  const admin = await db.user.upsert({
    where: { email },
    update: { name, initials: initialsFor(name) },
    create: {
      email,
      name,
      initials: initialsFor(name),
      role: "admin",
      emailVerified: true,
    },
  });

  console.info(`Printer owner ready: ${admin.name} <${admin.email}>`);

  // A `credential` account with a password is the thing that makes signing in
  // possible. A passkey creates no such row, so somebody who enrolled one and
  // never set a password still counts as needing this — which is correct: the
  // passkey is the accelerator, the password is the way back.
  const credential = await db.account.findFirst({
    where: { userId: admin.id, providerId: "credential", password: { not: null } },
    select: { id: true },
  });

  if (credential) {
    console.info(
      "A password is already set. Re-seeding never resets it — use " +
        "\"Forgotten password?\" on the guest list if it has been lost.",
    );
    return;
  }

  // Any link an earlier run printed goes first, so "re-run it and a fresh link
  // appears" is true rather than "and now there are two". Reset rows are the
  // only ones whose value is a bare user id; WebAuthn challenges store JSON.
  await db.verification.deleteMany({ where: { value: admin.id } });

  const token = newResetToken();
  await db.verification.create({
    data: {
      identifier: resetIdentifier(token),
      value: admin.id,
      expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
    },
  });

  const url = appUrl(`/set-password?token=${encodeURIComponent(token)}`);

  console.info(
    `\nNo password set yet. Open this once, within ${RESET_TTL_MINUTES} minutes,\n` +
      `to choose a username and a password:\n\n  ${url}\n\n` +
      "Then invite the rest of the office from /admin/invites.\n" +
      "Lost it? Re-run the seed and a fresh link is printed.",
  );
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
