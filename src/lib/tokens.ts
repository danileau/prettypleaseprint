import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 32 bytes (256 bits) of CSPRNG output, base64url encoded so it survives a
 * URL path segment untouched. Guessing one is not a threat model at this size.
 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Invite tokens are stored as a SHA-256 digest, never in the clear. A plain
 * hash (rather than a slow KDF) is the right call here: the input is 256 bits
 * of entropy, so there is no dictionary to run against it, and lookups stay a
 * single indexed query.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time compare for two hex digests of equal length. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Avatar fallback: the first two letters of the given name, uppercased.
 *
 * "Ayla Berg" -> "AY", not "AB". This follows the handoff's own examples —
 * every avatar in the prototype (AY, JO, SA, KW, RU) is a first name clipped
 * to two letters, which is what keeps a room full of Bergs distinguishable.
 */
export function initialsFor(name: string): string {
  const first = name.trim().split(/\s+/).filter(Boolean)[0];
  if (!first) return "??";
  // Intl-aware slice so an accented or non-Latin first name is not cut apart.
  return [...first].slice(0, 2).join("").toUpperCase();
}
