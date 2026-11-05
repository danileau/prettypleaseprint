/**
 * The two readings of the environment the seed needs from the app's sign-in
 * configuration, for an image that carries `prisma/` and nothing from `src/`.
 *
 * Each repeats one function in src/ and must agree with it exactly;
 * `verify:sso` holds them against each other on a table of inputs:
 *
 *   seedAuthMethods   ↔ authMethods  (src/lib/auth-methods.ts)
 *   seedNormalIssuer  ↔ normalIssuer (src/lib/oidc-flow.ts)
 *
 * The one difference is deliberate: where the app throws on a value that is
 * not a method, this reads it as best it can. The seed runs before the app,
 * in the migrator, and the app refuses that value by name on its first request.
 */

/** Which ways in are on. Unset, empty or blank means `local`. */
export function seedAuthMethods(raw: string | undefined): { local: boolean; oidc: boolean } {
  if (raw === undefined || raw.trim() === "") return { local: true, oidc: false };
  const names = raw.split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);
  return { local: names.includes("local"), oidc: names.includes("oidc") };
}

/** One spelling of an issuer: scheme and host in lower case, no default port, no trailing slash. */
export function seedNormalIssuer(issuer: string): string {
  try {
    const u = new URL(issuer);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return issuer.replace(/\/+$/, "");
  }
}
