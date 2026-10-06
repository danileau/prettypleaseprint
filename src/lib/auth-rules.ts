/**
 * The auth rules both sides need: what counts as a username and a password,
 * and how long a session lives.
 *
 * Its own module because `src/lib/auth.ts` hands these to Better Auth while
 * the registration and set-password forms render them as hints and as
 * `minLength` attributes, and `src/middleware.ts` needs the session window.
 * Importing `auth.ts` into a client component or into middleware would drag
 * the database and `server-only` where neither belongs, and a rule stated
 * twice is a rule that drifts.
 */

/**
 * Usernames: 3–32 characters of letters, digits, `-` and `_`.
 *
 * Narrower than Better Auth's default, which also allows `.`. Case is
 * accepted but not kept: the plugin folds to lower case on write and looks up
 * by the folded value, so `Ayla_B` is stored as `ayla_b`, signs in as either,
 * and cannot be registered twice in different clothes. `displayUsername`
 * keeps whatever was typed, for showing back.
 *
 * Matching case-insensitively rather than refusing capitals is the friendlier
 * half of that: somebody whose phone capitalises the first letter should be
 * told their username is taken, not that it is malformed.
 */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const USERNAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
export const USERNAME_RULE =
  "A username is 3–32 characters: letters, digits, hyphen or underscore.";

/**
 * Ten, not Better Auth's default eight.
 *
 * Length is the control that does the work; composition rules mostly move
 * people to `Password1!`. The upper bound exists so a megabyte of "a" cannot
 * be handed to the hasher as a denial-of-service lever.
 */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/**
 * How long a session survives with nobody touching it: twenty minutes.
 *
 * Stated here rather than inline in `auth.ts` because `src/middleware.ts`
 * needs the same number — see the cookie re-stamp there — and these two
 * disagreeing would either log people out early or keep a cookie alive past
 * the session it names.
 *
 * The reasoning for twenty minutes is in `auth.ts` beside `expiresIn`.
 */
export const SESSION_IDLE_SECONDS = 60 * 20;

/**
 * How long a member's device stays signed in: four hundred days.
 *
 * Members have no password. Opening an invitation — or a device link the
 * printer owner hands over — and typing a name signs that browser in, and the
 * browser is the credential from then on. Four hundred days because it is the
 * longest a browser will keep a cookie at all (Chrome caps `Max-Age` there),
 * so asking for more would be a number nothing honours.
 *
 * Fixed, not sliding: `expiresIn` stays twenty minutes for the printer owner,
 * and Better Auth only slides a session once it is within that of expiring.
 * A device session simply lasts its four hundred days and then asks for a new
 * link. See `src/lib/device-sessions.ts`.
 */
export const DEVICE_SESSION_SECONDS = 60 * 60 * 24 * 400;

/**
 * Marks a browser whose session is a member's device session, so that
 * `src/middleware.ts` leaves its cookie's `Max-Age` alone instead of cutting
 * it to twenty minutes. Holds a digest of that session's token rather than a
 * flag, so a marker left behind cannot spare a later sign-in on the same
 * browser — the printer owner's, say — from the twenty-minute rule.
 */
export const DEVICE_MARKER_COOKIE = "ppp.device";

/** How long a device link the printer owner mints stays usable. */
export const DEVICE_LINK_TTL_MINUTES = 30;

/**
 * The session cookie, under both the names it can have.
 *
 * `advanced.cookiePrefix` makes it `ppp.session_token`, and Better Auth adds
 * the `__Secure-` prefix wherever the deployment is served over HTTPS. Which
 * one is live depends on the URL rather than on `NODE_ENV`, so anything
 * looking for the cookie by name has to accept either.
 */
export const SESSION_COOKIE_NAMES = [
  "__Secure-ppp.session_token",
  "ppp.session_token",
] as const;

/**
 * How long a sign-in counts as "just now" for the actions that hand out or
 * take away access: five minutes.
 *
 * The sudo window. It is short because it is not a convenience — the whole
 * point is that somebody holding a captured cookie cannot use it to invite an
 * account, mint a password-reset link or revoke a colleague without producing
 * the passkey or the password again.
 *
 * Five minutes rather than thirty seconds because the admin screens involve
 * reading before acting, and rather than an hour because an hour is most of a
 * working session and would gate almost nothing.
 */
export const FRESH_AUTH_SECONDS = 60 * 5;
