/**
 * What counts as a username and a password.
 *
 * Its own module because both sides need it: `src/lib/auth.ts` hands these to
 * Better Auth, and the registration and set-password forms render them as
 * hints and as `minLength` attributes. Importing `auth.ts` into a client
 * component would drag the database and `server-only` into the browser
 * bundle, and a rule stated twice is a rule that drifts.
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
