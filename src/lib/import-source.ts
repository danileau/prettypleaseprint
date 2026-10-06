/**
 * Which sites a model may be imported from, and what counts as a link to one.
 *
 * Pure — no request, no database, no network — and deliberately apart from
 * `import.ts`, which is `server-only` because it makes the outbound calls. The
 * same split as `scope.ts` and `authz.ts`, for the same reason: the form needs
 * to know what a link looks like, and the suites exercise these rules directly
 * rather than re-implementing them.
 */

export const IMPORT_SOURCES = ["printables"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const SOURCE_LABEL: Record<ImportSource, string> = {
  printables: "Printables",
};

/**
 * The sources this deployment has switched on. None, unless it says so.
 *
 * Importing makes the server fetch from a site its operator may never have
 * heard of, on the say-so of whoever is signed in. An instance that has run
 * for months without doing that should not start because it was upgraded. So it is opt-in, by name:
 * `IMPORT_SOURCES=printables`.
 *
 * A name that is not a source is an error rather than something to skip.
 * `IMPORT_SOURCES=printable` silently meaning "off" is the kind of quiet
 * fallback that costs an afternoon.
 */
export function enabledSources(raw: string | undefined = process.env.IMPORT_SOURCES): ImportSource[] {
  const names = (raw ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const unknown = names.filter((name) => !(IMPORT_SOURCES as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `IMPORT_SOURCES names ${unknown.map((n) => JSON.stringify(n)).join(", ")}, ` +
        `which is not a source this app can import from. Known: ${IMPORT_SOURCES.join(", ")}.`,
    );
  }
  return IMPORT_SOURCES.filter((source) => names.includes(source));
}

/** The hosts a pasted link may name. Exact, never a suffix match. */
const PRINTABLES_HOSTS = new Set(["www.printables.com", "printables.com"]);

/**
 * `/model/3161-3d-benchy`, optionally behind a two-letter locale and followed
 * by a tab (`/files`, `/comments`). The id is the digits; the slug after it is
 * decoration and is thrown away.
 */
const PRINTABLES_PATH = /^\/(?:[a-z]{2}\/)?model\/(\d{1,12})(?:-[^/]*)?(?:\/.*)?$/;

/**
 * The model a Printables link points at, or null if it is not one.
 *
 * All this ever yields is a number. The link is parsed, the id is taken out,
 * and the link is thrown away — nothing the requester typed is fetched, stored
 * or echoed into a URL, which is what keeps this from being a way to make the
 * server request an address of somebody's choosing. The host is compared
 * whole after parsing, for the reason `safe-redirect.ts` sets out at length:
 * the question is what a URL parser makes of the string, and
 * `printables.com.evil.example` and `printables.com@evil.example` both
 * contain the right letters.
 */
export function parsePrintablesUrl(raw: string): { modelId: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  if (!PRINTABLES_HOSTS.has(url.hostname)) return null;
  const match = PRINTABLES_PATH.exec(url.pathname);
  return match ? { modelId: match[1]! } : null;
}

/** Which source a link belongs to, among the ones given. */
export function identifySource(
  raw: string,
  enabled: readonly ImportSource[],
): { source: ImportSource; modelId: string } | null {
  if (enabled.includes("printables")) {
    const parsed = parsePrintablesUrl(raw);
    if (parsed) return { source: "printables", modelId: parsed.modelId };
  }
  return null;
}

/**
 * A stored source link, if it is one this app could have written.
 *
 * `Story.sourceUrl` is built by the server, so this should always pass. It is
 * checked again on the way out because the value is rendered as an `href`,
 * and a link is the one place a string from a database column can do harm by
 * being something other than what it claims.
 */
export function trustedSourceLink(stored: string | null | undefined): { href: string; label: string } | null {
  if (!stored) return null;
  let url: URL;
  try {
    url = new URL(stored);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "www.printables.com") return null;
  if (!PRINTABLES_PATH.test(url.pathname)) return null;
  return { href: url.toString(), label: SOURCE_LABEL.printables };
}
