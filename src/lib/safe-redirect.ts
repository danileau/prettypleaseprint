/**
 * Where a redirect target is allowed to point.
 *
 * Open redirects are how a phishing page borrows your domain's credibility,
 * and this app hands a `?next=` or a form's `from` straight to the browser
 * right after a successful sign-in or re-auth — the two moments a person is
 * most willing to believe whatever they land on.
 *
 * There used to be four copies of this rule, in the sign-in page, the re-auth
 * page and the two server-action helpers, and all four were wrong the same
 * way:
 *
 *     raw.startsWith("/") && !raw.startsWith("//")
 *
 * A backslash walks straight through that. `/\evil.example` starts with "/"
 * and does not start with "//", so it was returned verbatim — and the WHATWG
 * URL parser treats "\" as "/" in the relative-slash state, so the browser
 * resolves it to https://evil.example/. Two more variants (`/\/` and `/\\`)
 * do the same.
 *
 * The lesson is not "also reject backslashes". It is that prefix matching
 * cannot answer this question at all, because the question is *what will a URL
 * parser do with this string* — so the check asks one. Resolve the target
 * against an origin that cannot exist and keep it only if it stayed there.
 * Anything that escapes, by whatever spelling, has moved off-origin and is
 * refused.
 *
 * Pure on purpose — no `server-only` — so the probes can exercise it directly
 * rather than re-implementing it and drifting, which is the same reasoning
 * `src/lib/scope.ts` is separate from `src/lib/authz.ts`.
 */

/**
 * An origin no deployment can ever be. Resolving against a real one would let
 * a target that happens to match the deployment's own host pass for the wrong
 * reason.
 */
const SENTINEL = "https://redirect.invalid";

/**
 * A same-origin target, or `fallback`. Keeps the query string and fragment,
 * because a redirect back to a filtered board is supposed to keep its filter.
 */
export function safeRedirect(raw: unknown, fallback = "/"): string {
  if (typeof raw !== "string" || raw === "") return fallback;

  let url: URL;
  try {
    url = new URL(raw, SENTINEL);
  } catch {
    return fallback;
  }

  // `origin` is what the browser will act on, and it is the whole test: an
  // absolute URL, a protocol-relative one, and every backslash spelling all
  // land somewhere that is not the sentinel.
  if (url.origin !== SENTINEL) return fallback;

  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * As `safeRedirect`, but bare path only.
 *
 * The server actions rebuild the query string themselves — the toast travels
 * in it — so a target arriving with one would end up with two.
 */
export function safeRedirectPath(raw: unknown, fallback: string): string {
  const target = safeRedirect(raw, fallback);
  const path = target.split("?")[0]!.split("#")[0]!;
  return path === "" ? fallback : path;
}
