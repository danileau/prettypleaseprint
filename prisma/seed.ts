/**
 * Bootstraps the single admin — the printer owner.
 *
 * This is the one account that is not created by an invitation, because
 * somebody has to be able to send the first one. It is written straight
 * through Prisma rather than Better Auth: there is no credential to
 * establish, only a row. The admin signs in with a magic link like everyone
 * else, and registers a passkey on first sign-in.
 *
 * Idempotent: re-running it updates the name and leaves everything else be.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

// Mirrors src/lib/tokens.ts. Duplicated so the seed runs without the app's
// module graph (and its "server-only" imports).
function initialsFor(name: string): string {
  const first = name.trim().split(/\s+/).filter(Boolean)[0];
  if (!first) return "??";
  return [...first].slice(0, 2).join("").toUpperCase();
}

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

  console.info(
    `Printer owner ready: ${admin.name} <${admin.email}>\n` +
      `Sign in at ${process.env.BETTER_AUTH_URL ?? "http://localhost:3000"}/signin ` +
      `and invite the rest of the office from /admin/invites.`,
  );
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
