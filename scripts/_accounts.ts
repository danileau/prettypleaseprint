/**
 * Test-account plumbing shared by the verification suites.
 *
 * Every suite except `verify:auth` needs a signed-in browser before it can
 * test the thing it is actually about. `verify:auth` owns the real path —
 * invite, register, sign in — and proves it works; the rest take the short
 * way round: a user row, a password set through Better Auth's own reset
 * endpoint, and a username/password sign-in over real HTTP.
 *
 * The password is still set through the app rather than written into the
 * database, so the hashing is the app's and a suite cannot pass against a
 * credential the app would not accept.
 */
import { db } from "../src/lib/db";
import { issuePasswordSetupUrl } from "../src/lib/password-reset";

/**
 * The password every suite uses.
 *
 * Long, and deliberately nonsense: `haveIBeenPwned` refuses anything in a
 * breach corpus, and "correct horse battery staple" is very much in one.
 */
export const TEST_PASSWORD = "ppp-suite-3d-printer-parked-outside";

/** Anything with a `raw()` — every suite's cookie-jar Browser qualifies. */
export type HttpClient = {
  raw(url: string, init?: RequestInit): Promise<Response>;
};

/**
 * Give an account a username and a password, whatever state it is in.
 *
 * The set-password link is minted server-side and redeemed over HTTP, which
 * is exactly what the admin's "Forgotten password?" control does — so this
 * exercises the mechanism rather than working around it.
 */
export async function ensureCredentials(
  app: string,
  userId: string,
  username: string,
  password: string = TEST_PASSWORD,
): Promise<void> {
  // The username is not part of the reset endpoint's job; the set-password
  // form writes it the same way for an account that has none.
  await db.user.update({
    where: { id: userId },
    data: { username: username.toLowerCase(), displayUsername: username },
  });

  const url = await issuePasswordSetupUrl(userId);
  const token = new URL(url).searchParams.get("token")!;

  const res = await fetch(`${app}/api/auth/reset-password`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: app },
    body: JSON.stringify({ token, newPassword: password }),
  });
  if (!res.ok) {
    throw new Error(
      `could not set a password for ${userId}: ${res.status} ${await res.text()}`,
    );
  }
}

/** Sign a browser in. Returns the raw response so a suite can assert on it. */
export function signInWithPassword(
  client: HttpClient,
  app: string,
  username: string,
  password: string = TEST_PASSWORD,
): Promise<Response> {
  return client.raw(`${app}/api/auth/sign-in/username`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: username.toLowerCase(), password }),
  });
}

/** A username from an address: `ayla@office.example` -> `ayla`. */
export function usernameFor(email: string): string {
  return email.split("@")[0]!.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}
