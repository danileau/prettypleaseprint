/**
 * Content-Security-Policy, built per request around a fresh nonce.
 *
 * The value that matters is `script-src`. Next.js hydrates from an inline
 * bootstrap script, so a nonce-less policy would have to allow
 * 'unsafe-inline' there — which makes the whole header decorative. Instead
 * middleware mints a nonce per request and Next stamps it onto its own
 * scripts, so inline script runs only when it carries that request's nonce.
 *
 * `strict-dynamic` lets those nonced scripts pull in the rest of the Next
 * chunk graph without every chunk needing its own nonce. Browsers that honour
 * it ignore the host allowlist; older ones fall back to 'self'.
 *
 * `style-src` does NOT need 'unsafe-inline'. next/font self-hosts its
 * webfonts into /_next/static at build time, so the rendered page contains no
 * inline <style> block and no request to fonts.googleapis.com — verified
 * against the built output. What the page does contain is a couple of inline
 * `style=` attributes from component code, and those are governed separately
 * by `style-src-attr`. Splitting the two keeps the broad allowance off the
 * directive that can pull in a whole stylesheet.
 *
 * Development relaxes script-src because the dev server needs eval for HMR.
 */
export function buildCsp(nonce: string, isProd: boolean): string {
  return [
    "default-src 'self'",
    isProd
      ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`
      : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self'",
    // Inline style="" attributes only — not inline <style> blocks.
    "style-src-attr 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    // This app talks to its own origin only. No analytics, CDN or beacons.
    // When model-file upload lands, the object-storage origin has to be added
    // here (and to img-src if thumbnails are served from it) — a signed S3
    // URL is cross-origin and this directive will otherwise block the fetch.
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    ...(isProd ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** 128 bits of CSPRNG, base64 — a nonce must never repeat across responses. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
