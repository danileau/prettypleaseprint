import "server-only";
import { z } from "zod";

import {
  SOURCE_LABEL,
  enabledSources,
  identifySource,
  type ImportSource,
} from "@/lib/import-source";
import { extensionOf } from "@/lib/models";
import { sourceUrl as appSourceUrl } from "@/lib/runtime";
import { StoryProblem } from "@/lib/stories";
import { ACCEPTED_EXTENSIONS, MAX_UPLOAD_BYTES, formatBytes } from "@/lib/upload-limits";

/**
 * Fetching a model from the site it is published on.
 *
 * This is the only place the app makes a request to somebody else's server
 * because a *requester* asked it to — the breach check and outgoing mail call
 * out too, but to addresses the operator configured. It is off unless a
 * deployment names a source in `IMPORT_SOURCES`, and everything here is
 * arranged around one question — *whose choice is the address being
 * requested?* — and the answer is never "the person who pasted the link":
 *
 *   1. The pasted link is parsed for a model id and thrown away
 *      (`import-source.ts`). All that survives is digits.
 *   2. The listing is asked of one fixed endpoint, with that id as a GraphQL
 *      variable. It is not interpolated into a URL or a query.
 *   3. The download link comes back from that same endpoint, and is fetched
 *      only if it is on the one origin files are served from. A link pointing
 *      anywhere else is refused before a connection is opened.
 *   4. Redirects are an error, not something to follow. A redirect is the
 *      remote end choosing a new address, which is the thing being prevented.
 *
 * So a requester decides *which model*; the code decides *which host*. The
 * file that arrives is then treated exactly as an upload is — `intake.ts`
 * inspects the bytes and does not care what the site said they were.
 *
 * **The API is not a published one.** Printables has no documented public API;
 * this speaks the GraphQL endpoint its own website uses, and it can change
 * without notice. When it does, every failure below says so in words and
 * points at the upload that always works. Nothing here falls back to guessing.
 */

const problem = (status: number, message: string) => new StoryProblem(status, message);

/** What to do instead, appended to every failure that is not the requester's. */
const UPLOAD_INSTEAD = "Download the file and upload it here instead.";

const API_TIMEOUT_MS = 15_000;
/** Generous: 250 MB from a CDN over a home line is minutes, not seconds. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
/** A listing is a few kilobytes. This is only so a wrong answer cannot be huge. */
const MAX_API_BYTES = 2 * 1024 * 1024;
const MAX_LISTED_FILES = 200;

/**
 * Where Printables is.
 *
 * Two fixed addresses, and they are the whole allowlist: the API, and the one
 * origin a download link may point at.
 *
 * `IMPORT_PRINTABLES_BASE` replaces both with a single origin. It exists for
 * `verify:import`, which runs against the built image and cannot have that
 * image calling the real Printables on every CI run — the suite points it at
 * `scripts/stubs/printables-stub.mjs` instead. It is the operator's
 * environment, not anything a request can reach, and it narrows as much as it
 * moves: with it set, the stand-in is the *only* host the importer will talk
 * to. Do not set it in a deployment.
 */
function printables(): { api: string; fileOrigin: string } {
  const override = process.env.IMPORT_PRINTABLES_BASE;
  if (override) {
    const base = new URL(override);
    return { api: new URL("/graphql/", base).toString(), fileOrigin: base.origin };
  }
  return {
    api: "https://api.printables.com/graphql/",
    fileOrigin: "https://files.printables.com",
  };
}

/** Says who is calling, and where the source is. Not a browser, and not pretending. */
const userAgent = () => `PrettyPleasePrint (+${appSourceUrl()})`;

/** The sources switched on, or a refusal that says importing is off. */
export function importSourcesOrRefuse(): ImportSource[] {
  const enabled = enabledSources();
  if (enabled.length === 0) {
    throw problem(501, "Importing from a link is not switched on for this instance.");
  }
  return enabled;
}

// ---------------------------------------------------------------------------
// Talking to Printables
// ---------------------------------------------------------------------------

/** Read a body, giving up rather than buffering more than `limit` bytes. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limit) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return new Uint8Array(0);

  // One buffer of the size allowed, filled in place. Collecting chunks and
  // joining them afterwards would hold the model twice at the moment it is
  // largest, and the slot gate is sized for holding it once.
  const out = new Uint8Array(limit);
  let length = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (length + value.byteLength > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    out.set(value, length);
    length += value.byteLength;
  }
  return out.subarray(0, length);
}

const unavailable = (what: string) =>
  problem(502, `Printables ${what}. ${UPLOAD_INSTEAD}`);

async function graphql(query: string, variables: Record<string, string>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(printables().api, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": userAgent(),
      },
      body: JSON.stringify({ query, variables }),
      redirect: "error",
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[import] printables api unreachable", error);
    throw unavailable("could not be reached from here");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    console.error(`[import] printables api answered ${response.status}`);
    throw unavailable(`answered ${response.status}`);
  }

  const raw = await readCapped(response, MAX_API_BYTES).catch(() => null);
  if (!raw) throw unavailable("sent an answer this app could not read");
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw unavailable("sent an answer this app could not read");
  }
}

/**
 * What the listing has to look like to be believed.
 *
 * Parsed rather than trusted, because the shape is somebody else's and
 * undocumented: the day it changes, this fails by name instead of letting an
 * `undefined` wander into a ticket.
 */
const ListingSchema = z.object({
  data: z.object({
    print: z
      .object({
        id: z.string().regex(/^\d{1,12}$/),
        name: z.string().max(500),
        slug: z.string().max(300).nullish(),
        user: z.object({ publicUsername: z.string().max(200).nullish() }).nullish(),
        license: z.object({ name: z.string().max(300).nullish() }).nullish(),
        stls: z
          .array(
            z.object({
              id: z.string().regex(/^\d{1,12}$/),
              name: z.string().min(1).max(500),
              fileSize: z.number().int().nonnegative(),
            }),
          )
          .max(5000),
      })
      .nullable(),
  }),
});

const LISTING_QUERY =
  "query PppModel($id: ID!) { print(id: $id) { id name slug user { publicUsername } " +
  "license { name } stls { id name fileSize } } }";

const LinkSchema = z.object({
  data: z.object({
    getDownloadLink: z
      .object({
        ok: z.boolean(),
        output: z.object({ link: z.string().max(4000) }).nullish(),
      })
      .nullable(),
  }),
});

const LINK_MUTATION =
  "mutation PppDownload($id: ID!, $printId: ID!, $fileType: DownloadFileTypeEnum!, " +
  "$source: DownloadSourceEnum!) { getDownloadLink(id: $id, printId: $printId, " +
  "fileType: $fileType, source: $source) { ok output { link } } }";

export type ImportableFile = { id: string; name: string; size: number; tooLarge: boolean };

export type ImportListing = {
  source: ImportSource;
  model: {
    id: string;
    name: string;
    /** The model's page, built here from the API's own id and slug. */
    url: string;
    author: string | null;
    license: string | null;
  };
  /** The `.stl` and `.3mf` files, in the site's order. */
  files: ImportableFile[];
  /** How many other files the model carries that cannot be printed here. */
  otherFiles: number;
};

const isPrintable = (name: string) =>
  (ACCEPTED_EXTENSIONS as readonly string[]).includes(extensionOf(name));

async function listPrintables(modelId: string): Promise<ImportListing> {
  const parsed = ListingSchema.safeParse(await graphql(LISTING_QUERY, { id: modelId }));
  if (!parsed.success) {
    console.error("[import] printables listing has an unexpected shape", parsed.error.issues[0]);
    throw unavailable("answered in a shape this app does not recognise — its API may have changed");
  }
  const print = parsed.data.data.print;
  if (!print) throw problem(404, "Printables has no model at that link.");
  // The id that comes back is the one stored and shown. If it is not the one
  // asked for, something is answering that is not what this code expects.
  if (print.id !== modelId) throw unavailable("answered about a different model");

  // The slug is decoration on a link people will click. Kept only if it looks
  // like one; the id alone still finds the model.
  const slug = print.slug && /^[a-z0-9-]{1,200}$/.test(print.slug) ? `-${print.slug}` : "";
  const printable = print.stls.filter((file) => isPrintable(file.name));

  return {
    source: "printables",
    model: {
      id: print.id,
      name: print.name,
      url: `https://www.printables.com/model/${print.id}${slug}`,
      author: print.user?.publicUsername ?? null,
      license: print.license?.name ?? null,
    },
    files: printable.slice(0, MAX_LISTED_FILES).map((file) => ({
      id: file.id,
      name: file.name,
      size: file.fileSize,
      tooLarge: file.fileSize > MAX_UPLOAD_BYTES,
    })),
    otherFiles: print.stls.length - printable.length,
  };
}

// ---------------------------------------------------------------------------
// The two operations
// ---------------------------------------------------------------------------

const NOT_A_LINK = (enabled: readonly ImportSource[]) =>
  `That is not a link to a model on ${enabled.map((s) => SOURCE_LABEL[s]).join(" or ")}.`;

/**
 * What a link offers: the model, and the files in it that could be printed.
 *
 * A model usually carries several files and a ticket holds one, so the
 * requester has to choose — this is what they choose from.
 */
export async function listImportable(rawUrl: unknown): Promise<ImportListing> {
  const enabled = importSourcesOrRefuse();
  const found = typeof rawUrl === "string" ? identifySource(rawUrl, enabled) : null;
  if (!found) throw problem(422, NOT_A_LINK(enabled));
  return listPrintables(found.modelId);
}

/**
 * One file's bytes, and where they came from.
 *
 * The listing is asked for again here rather than taken from the request. The
 * caller says which model and which file by id, and everything else — the
 * name, the size, whether that file belongs to that model at all — is read
 * from the site at the moment of fetching. A client cannot name a file from a
 * different model, or claim a small size for a large one.
 */
export async function fetchImportable(
  rawUrl: unknown,
  rawFileId: unknown,
): Promise<{ name: string; bytes: Uint8Array; listing: ImportListing }> {
  const listing = await listImportable(rawUrl);

  const fileId = typeof rawFileId === "string" || typeof rawFileId === "number" ? String(rawFileId) : "";
  if (!/^\d{1,12}$/.test(fileId)) throw problem(400, "Say which file to import.");
  const file = listing.files.find((candidate) => candidate.id === fileId);
  if (!file) throw problem(404, "That file is not one of that model's printable files.");
  if (file.tooLarge) {
    throw problem(
      413,
      `That file is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`,
    );
  }

  const minted = LinkSchema.safeParse(
    await graphql(LINK_MUTATION, {
      id: file.id,
      printId: listing.model.id,
      // The site files 3MFs under the same type as STLs. Verified against it.
      fileType: "stl",
      source: "model_detail",
    }),
  );
  const link = minted.success ? minted.data.data.getDownloadLink?.output?.link : null;
  if (!minted.success || !minted.data.data.getDownloadLink?.ok || !link) {
    throw unavailable("would not hand over that file");
  }

  // The one address in all of this that the remote end chose. It is fetched
  // only if it is where Printables serves files from, compared as an origin
  // after parsing — never as a prefix of the string.
  let target: URL;
  try {
    target = new URL(link);
  } catch {
    throw unavailable("gave a download link that is not a URL");
  }
  if (target.origin !== printables().fileOrigin || target.username || target.password) {
    console.error(`[import] refused a download link on ${target.origin}`);
    throw unavailable("pointed at an address this app does not fetch from");
  }

  let response: Response;
  try {
    response = await fetch(target, {
      headers: { "user-agent": userAgent() },
      redirect: "error",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("[import] download failed", error);
    throw unavailable("did not deliver the file");
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw unavailable(`answered ${response.status} for the file`);
  }

  // Held to the size the listing gave, which was already held to the cap. A
  // file that turns out larger than it was listed is refused as it arrives,
  // rather than after a quarter of a gigabyte has been buffered to find out.
  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(response, file.size);
  } catch (error) {
    console.error("[import] download was cut short", error);
    throw unavailable("did not deliver the whole file");
  }
  if (!bytes) throw unavailable("sent more than the file it listed");

  return { name: file.name, bytes, listing };
}
