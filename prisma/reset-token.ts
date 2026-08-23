/**
 * Password-setup tokens: minting, and the identifier they are stored under.
 *
 * This file sits beside the schema rather than in `src/lib` because two very
 * different things need it and only one of them can see the app:
 *
 *   - `prisma/seed.ts`, which mints the printer owner's first set-password
 *     link. The migrator image ships `prisma/` and three npm packages, so
 *     anything under `src/` is simply not there (see the Dockerfile).
 *   - `src/lib/password-reset.ts`, which mints one when the admin resets a
 *     member's password.
 *
 * Both write a row Better Auth will later consume through its own
 * `/reset-password` endpoint, so the identifier format below is not ours to
 * choose — it is Better Auth's, and the two constants encode it in one place
 * instead of two.
 */
import { createHash, randomBytes } from "node:crypto";

/**
 * Short enough that a link left in a chat window is not a standing key to the
 * account, long enough to survive being walked over to somebody's desk.
 */
export const RESET_TTL_MINUTES = 30;

/** 32 bytes of CSPRNG output, URL-safe. Guessing one is not a threat model. */
export function newResetToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The `verification.identifier` a reset token is filed under.
 *
 * Two layers, both Better Auth's:
 *   - the `reset-password:` prefix its `/reset-password` endpoint looks up
 *   - the digest applied by `verification.storeIdentifier: "hashed"`, which
 *     is SHA-256 over the identifier, base64url without padding
 *
 * Hashing is what keeps a database reader from replaying a live link. Keep
 * this in step with `storeIdentifier` in src/lib/auth.ts: change one and the
 * links silently stop resolving.
 */
export function resetIdentifier(token: string): string {
  return createHash("sha256")
    .update(`reset-password:${token}`, "utf8")
    .digest("base64url");
}
