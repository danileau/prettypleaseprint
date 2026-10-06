/**
 * The digest that ties `ppp.device` to one session token.
 *
 * Web Crypto rather than `node:crypto` because `src/middleware.ts` runs on the
 * edge runtime and has to compute the same value.
 */
export async function deviceMarkerFor(sessionToken: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`ppp-device:${sessionToken}`),
  );
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The bare token out of a signed session cookie.
 *
 * Better Auth writes `<token>.<signature>`, URL-encoded. The token is
 * alphanumeric and the signature is base64, so neither contains a dot.
 */
export function tokenFromSessionCookie(value: string): string {
  return decodeURIComponent(value).split(".")[0] ?? "";
}
