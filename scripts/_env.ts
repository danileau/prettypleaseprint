/**
 * Loads `.env` into the process environment, explicitly.
 *
 * The suites used to rely on Prisma loading `.env` on its own. That happens
 * to work on a developer machine and did not on a CI runner, where the whole
 * job failed with "Environment variable not found: DATABASE_URL" several
 * steps after the file had been written. Relying on a library's incidental
 * behaviour for something this load-bearing is not worth the ten lines it
 * takes to do properly.
 *
 * Import this FIRST in any script, before anything that reaches for a
 * connection string:
 *
 *   import "./_env";
 *   import { db } from "../src/lib/db";
 *
 * ESM evaluates modules in import order, so that guarantees the variables are
 * set before Prisma is constructed.
 *
 * Real environment variables always win — CI can export values directly and
 * a stale `.env` will not silently override them.
 */
import { existsSync, readFileSync } from "node:fs";

const FILE = process.env.PPP_ENV_FILE ?? ".env";

if (existsSync(FILE)) {
  for (const line of readFileSync(FILE, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    if (key in process.env) continue; // already set: leave it alone
    let value = m[2]!.trim();
    // Strip one layer of matching quotes, and drop trailing comments from
    // unquoted values only — a '#' inside a password is not a comment.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.split(" #")[0]!.trim();
    }
    process.env[key] = value;
  }
}

if (!process.env.DATABASE_URL) {
  console.error(
    `DATABASE_URL is not set, and ${FILE} did not supply it.\n` +
      "If the containerised stack is running, `npm run env:container` writes it.",
  );
  process.exit(1);
}
