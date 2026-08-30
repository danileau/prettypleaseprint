import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The credential the "Open in PrusaSlicer" link carries.
 *
 * The helper on somebody's own machine has to fetch model bytes from the app,
 * and it is not a browser: it holds no cookie. It used to hold a **bearer
 * token pasted into `~/.config/ppp/slicer.conf`** — which was the session
 * token, and therefore a thirty-day, full-authority credential sitting in a
 * file. Shortening sessions to twenty idle minutes broke that outright (the
 * helper started answering `HTTP 401`), and the fix is not a longer-lived
 * credential in the same place. It is not needing one.
 *
 * So the link carries its own authority instead. `ppp://slice/<id>?t=…` is
 * minted when the ticket is rendered, for the person looking at it and for
 * that model alone, and it expires in half an hour. Nothing secret is written
 * to disk at all: the config keeps only the address of the instance.
 *
 * **What this token is, precisely.** It asserts an *identity* and a *subject*,
 * and nothing else. It is not an authorisation: the route still loads the user,
 * refuses a suspended one, and re-applies `storyScope` against the database, so
 * a token cannot outlive the access it was minted under except within its own
 * half hour. Compared with what it replaces — the whole account, for thirty
 * days, revocable only by signing out — the exchange is a good one in every
 * direction.
 *
 * **Stateless on purpose.** An HMAC over the claim rather than a stored row:
 * the alternative writes a `verification` row on every render of every ticket,
 * to be read at most once and otherwise left to accumulate. The cost of that
 * choice is honest and worth stating: an outstanding link is **not** revoked by
 * signing out, because nothing is consulted to revoke. It IS revoked by
 * suspending the account, and by the scope check, and by half an hour passing.
 * For read access to one model the holder could already open, that is the right
 * side of the trade; it would not be for anything that writes.
 */

/** Half an hour: long enough to read a ticket and click, short enough to matter. */
export const SLICER_TOKEN_TTL_SECONDS = 60 * 30;

/** Bumped if the payload shape ever changes, so old links fail closed. */
const VERSION = "v1";

function signingKey(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    // Loud rather than a guessable fallback. A constant default here would
    // mean anybody who read the source could mint links against a deployment.
    throw new Error(
      "BETTER_AUTH_SECRET is required to sign slicer links. " +
        "It is the same secret Better Auth uses; set it in the environment.",
    );
  }
  return secret;
}

/** The signature covers the encoded payload verbatim, so there is nothing to canonicalise. */
function sign(encodedPayload: string): string {
  return createHmac("sha256", signingKey()).update(encodedPayload).digest("base64url");
}

/**
 * Mint a link credential for one person and one model.
 *
 * base64url throughout: the result goes in a `ppp://` URL that a desktop
 * environment hands to a shell script as an argument, and anything needing
 * escaping there is a bug waiting to happen.
 */
export function mintSlicerToken(userId: string, storyId: number): string {
  const expiresAt = Date.now() + SLICER_TOKEN_TTL_SECONDS * 1000;
  const payload = `${VERSION}.${storyId}.${userId}.${expiresAt}`;
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

/**
 * Read a link credential back, returning the user it was minted for.
 *
 * `storyId` is passed in and checked rather than trusted from the token: the
 * caller already knows which model was asked for, and a token minted for one
 * model must not fetch another. Returns null for anything at all wrong —
 * there is no partial success worth reporting to a caller holding a bad token.
 */
export function readSlicerToken(token: string, storyId: number): string | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts as [string, string];

  const expected = sign(encoded);
  const a = Buffer.from(signature, "base64url");
  const b = Buffer.from(expected, "base64url");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: string;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }

  // The user id is a cuid and carries no dots, so a fixed split is safe.
  const fields = payload.split(".");
  if (fields.length !== 4) return null;
  const [version, subject, userId, expiresAt] = fields as [string, string, string, string];

  if (version !== VERSION) return null;
  if (subject !== String(storyId)) return null;
  if (!userId) return null;

  const expiry = Number(expiresAt);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return null;

  return userId;
}
