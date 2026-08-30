/**
 * How large and how complex an uploaded model may be.
 *
 * Its own module because both sides need it: `src/lib/models.ts` enforces these
 * against the bytes that arrived, and the upload form checks the size in the
 * browser before spending someone's wifi on a file that will be refused.
 * Importing `models.ts` into a client component would drag `fflate` and the
 * whole mesh parser into the browser bundle — which is why the form had grown
 * its own copy of the limit, the extension list *and* `formatBytes`. Three
 * rules stated twice are three rules that drift; raising the cap used to mean
 * finding five places.
 */

/**
 * 250 MB, up from the handoff's 50 MB.
 *
 * 50 MB was chosen for "a handful of people and one printer" and it held until
 * people started bringing real work: multi-object plates and scanned meshes go
 * past it easily, and the app's answer was "decimate the mesh", which is asking
 * someone to damage their model to fit an arbitrary number.
 *
 * The number is not free, and what it costs is memory rather than disk — see
 * `MAX_CONCURRENT_UPLOADS` below, which is what keeps that bounded. If a
 * deployment has less RAM than this assumes, this is the line to lower.
 */
export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

/**
 * A 3MF is a zip, and the interesting attack is a small file that inflates
 * enormously. Scaled off the byte cap rather than fixed, so raising one does
 * not silently leave the other behind: a legitimate 3MF compresses several
 * times over, and three is a generous allowance for real geometry while still
 * refusing anything shaped like a bomb.
 */
export const MAX_INFLATED_BYTES = 3 * MAX_UPLOAD_BYTES;

/**
 * "Complex" has its own ceiling, separate from file size.
 *
 * Eight million triangles is an enormous mesh — most printable models are
 * under one. It does not bind for a binary STL at the current byte cap (250 MB
 * is about 5.2M triangles at 50 bytes each), so in practice this catches a
 * 3MF that claims far more geometry than its size suggests.
 */
export const MAX_TRIANGLES = 8_000_000;

/**
 * How many uploads may be inspected at once.
 *
 * This is the control that makes the cap above safe rather than hopeful. The
 * request body is buffered before any of this app's code runs, so peak memory
 * is set by how many large uploads are in flight — not by anything the
 * validator does. Two at a time bounds it; a third waits its turn rather than
 * being refused, because someone who has just spent a minute uploading 200 MB
 * should not be told to start again.
 *
 * The audit named this: "a streaming parse, or a size-based queue, is the
 * answer then". This is the queue. The streaming parse is a larger change and
 * is written up in docs/architecture.md.
 */
export const MAX_CONCURRENT_UPLOADS = 2;

/** How many may be waiting for a slot before the app says no. */
export const MAX_QUEUED_UPLOADS = 6;

/**
 * The ceiling on the whole request, as opposed to the file inside it.
 *
 * A multipart body is the file plus boundaries plus the wish fields, so a
 * legitimately maximum-sized model arrives as a slightly larger request. Both
 * the transport limit and the app's own cheap content-length check use this,
 * and they have to be the *same* number: when the transport cut off at exactly
 * `MAX_UPLOAD_BYTES`, a file just over the cap had its body truncated and the
 * uploader was told the upload "did not arrive intact" instead of that the file
 * was too big. The transport has to be the more generous of the two so the
 * app's own check is the one that answers.
 */
export const MAX_REQUEST_BYTES = Math.ceil(MAX_UPLOAD_BYTES * 1.2);

/**
 * The largest model the in-browser viewer will attempt.
 *
 * Not a limit on what may be uploaded — it is a limit on what a laptop can be
 * asked to rebuild. The viewer downloads the whole file and hands it to a
 * loader that expands it into typed arrays: a binary STL is about a million
 * triangles at this size, and roughly 36 bytes of buffer per triangle once
 * parsed. Past here the tab stops responding for long enough that people
 * assume the app is broken, which is a worse outcome than not previewing.
 *
 * It is the old upload cap, which is a coincidence worth naming: 50 MB was
 * always about what a browser could cope with, even when it was written down
 * as what the server would accept.
 */
export const VIEWER_MAX_BYTES = 50 * 1024 * 1024;

export const ACCEPTED_EXTENSIONS = [".stl", ".3mf"] as const;

/** Bytes as a person would say them. Shared so the form and the API agree. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
