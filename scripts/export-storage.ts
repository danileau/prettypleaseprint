/**
 * Copy every stored model out of MinIO and onto the filesystem, then prove it.
 *
 *   npm run migrate:storage          export, then verify
 *   npm run migrate:storage -- --verify-only    check an earlier run
 *
 * ---------------------------------------------------------------------------
 * Why this is a script and not a documented `mc` command
 * ---------------------------------------------------------------------------
 *
 * MinIO does not store objects as files. Each one is a *directory* named after
 * the key, and for anything under its inline threshold the bytes live inside
 * `xl.meta` rather than beside it. On the dataset this was written against,
 * 160 of 179 objects were inlined — 89%.
 *
 * So the intuitive migration, `cp -r` the models directory and point the new
 * code at it, recovers about a tenth of the models and loses the rest. And it
 * loses them *quietly*: the directory tree is there, the filenames are there,
 * every ticket page still renders, and the only symptom is that opening a model
 * fails. Partial, silent, and entirely plausible-looking.
 *
 * The bytes can only come out through the S3 API, which is what this does.
 *
 * ---------------------------------------------------------------------------
 * What makes it safe
 * ---------------------------------------------------------------------------
 *
 *   * It writes to a NEW directory and never touches MinIO's. Nothing it does
 *     is destructive; rolling back is deleting what it wrote.
 *   * It verifies against the DATABASE, not against MinIO. Asking MinIO whether
 *     it exported everything is asking the wrong witness — it would have
 *     happily confirmed 179 objects while 160 arrived empty. Every `Story` row
 *     must end up with a readable file of the right size.
 *   * It checks the bytes are a model, not just the right length. A file of
 *     zeroes passes a size comparison.
 *   * It is idempotent. A second run skips what is already correct, so it can
 *     be re-run after a partial failure, or again later to pick up uploads that
 *     happened in between.
 *   * It refuses to exit 0 if a single row is unaccounted for.
 *
 * DESTRUCTIVE: nothing. It only ever creates files under MODELS_ROOT.
 */
import "./_env";
import { createWriteStream } from "node:fs";
import { chown, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

import { db } from "../src/lib/db";

/**
 * Where the files are going. Inside the container this is the mount that will
 * become the app's storage root; on a host run, point it wherever the volume
 * actually lives.
 */
const ROOT = resolve(process.env.MODELS_ROOT ?? "/uploads");
const BUCKET = process.env.S3_BUCKET ?? "ppp-models";

/*
 * The app serves as uid 1001 (`USER nextjs` in the Dockerfile), and this runs
 * as root so it can write into a bind mount Docker created as root. Files
 * would inherit root ownership and mode 0640, which the app could then not
 * read — a migration that completes and leaves every model unreadable.
 *
 * So hand over what we create. Only when running as root: on a host run as a
 * normal user the files already belong to the right person and chown would
 * fail.
 */
const OWNER_UID = Number(process.env.MODELS_UID ?? 1001);
const OWNER_GID = Number(process.env.MODELS_GID ?? 1001);
const RUNNING_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

async function handOver(path: string): Promise<void> {
  if (!RUNNING_AS_ROOT) return;
  await chown(path, OWNER_UID, OWNER_GID);
}

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: process.env.S3_REGION ?? "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY ?? "ppp",
    secretAccessKey: process.env.S3_SECRET_KEY ?? "dev-only-not-a-secret",
  },
});

/**
 * Resolve a storage key under ROOT, refusing anything that climbs out.
 *
 * Keys are generated UUIDs so this should never fire, but the value arrives
 * from a database column and the cost of being wrong is writing outside the
 * volume. Resolved and compared rather than prefix-matched, for the same reason
 * `src/lib/safe-redirect.ts` resolves instead of matching: the question is what
 * a path parser will do with the string.
 */
function pathFor(key: string): string {
  const full = resolve(ROOT, key);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) {
    throw new Error(`storage key escapes the root: ${JSON.stringify(key)}`);
  }
  return full;
}

/**
 * Is this plausibly the model it claims to be, rather than the right number of
 * wrong bytes?
 *
 * A binary STL states its own triangle count, and 84 + count*50 has to equal
 * the file length — the same structural check `src/lib/models.ts` makes on
 * upload. A 3MF is a zip, so it starts "PK". Cheap, and it catches a truncated
 * or zero-filled copy that a size comparison would wave through.
 */
async function looksLikeAModel(path: string, size: number): Promise<string | null> {
  const fh = await open(path, "r");
  try {
    const head = Buffer.alloc(84);
    const { bytesRead } = await fh.read(head, 0, 84, 0);
    if (bytesRead < 5) return "file is too short to be a model";
    if (path.endsWith(".3mf")) {
      return head[0] === 0x50 && head[1] === 0x4b ? null : "not a zip archive";
    }
    // ASCII STL is legal too; only the binary form makes an arithmetic claim.
    if (head.subarray(0, 5).toString("ascii").toLowerCase() === "solid") return null;
    const triangles = head.readUInt32LE(80);
    const expected = 84 + triangles * 50;
    return expected === size ? null : `binary STL claims ${triangles} triangles (${expected} bytes) but the file is ${size}`;
  } finally {
    await fh.close();
  }
}

/** Write bytes so that a crash can never leave a half file under the real name. */
async function writeAtomically(finalPath: string, body: Readable): Promise<void> {
  await mkdir(dirname(finalPath), { recursive: true });
  // Every level we may have just created, not only the leaf.
  for (let dir = dirname(finalPath); dir.startsWith(ROOT); dir = dirname(dir)) {
    await handOver(dir);
    if (dir === ROOT) break;
  }
  const tmp = `${finalPath}.tmp-${randomUUID()}`;
  try {
    await pipeline(body, createWriteStream(tmp, { mode: 0o640 }));
    // fsync before the rename, or the rename can land before the contents do
    // and a power cut leaves a correctly-named empty file. The database row
    // will claim that file is whole, so this is worth the syscall.
    const fh = await open(tmp, "r+");
    await fh.sync();
    await fh.close();
    await rename(tmp, finalPath);
    await handOver(finalPath);
    // And the directory entry itself.
    const dh = await open(dirname(finalPath), "r");
    await dh.sync();
    await dh.close();
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

type Row = { id: number; storageKey: string; filename: string; fileSize: number };

/** Already there, right size, and plausibly a model? Then leave it alone. */
async function alreadyGood(row: Row): Promise<boolean> {
  try {
    const info = await stat(pathFor(row.storageKey));
    if (!info.isFile() || info.size !== row.fileSize) return false;
    return (await looksLikeAModel(pathFor(row.storageKey), info.size)) === null;
  } catch {
    return false;
  }
}

async function exportOne(row: Row): Promise<void> {
  const object = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: row.storageKey }),
  );
  if (!object.Body) throw new Error("storage returned no body");
  await writeAtomically(pathFor(row.storageKey), object.Body as Readable);
}

/** Every object in the bucket, so unreferenced leftovers can be counted. */
async function listAllKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token }),
    );
    for (const o of page.Contents ?? []) if (o.Key) keys.add(o.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function main() {
  const verifyOnly = process.argv.includes("--verify-only");

  /*
   * The one mistake that would be unrecoverable is exporting *into* MinIO's own
   * data directory, so refuse outright rather than trusting the operator to
   * have read the docs. `.minio.sys` is the tell.
   */
  try {
    await stat(join(ROOT, ".minio.sys"));
    console.error(
      `\nMODELS_ROOT (${ROOT}) is MinIO's own data directory.\n` +
        "Export somewhere else. Writing here would mix plain files into the\n" +
        "object store's layout and put the only copy of the data at risk.\n",
    );
    process.exit(2);
  } catch {
    // Not MinIO's directory. Good.
  }

  await mkdir(ROOT, { recursive: true });
  await handOver(ROOT);

  const rows: Row[] = await db.story.findMany({
    select: { id: true, storageKey: true, filename: true, fileSize: true },
    orderBy: { id: "asc" },
  });

  console.info(`\n  source   s3://${BUCKET} at ${process.env.S3_ENDPOINT ?? "http://localhost:9000"}`);
  console.info(`  target   ${ROOT}`);
  console.info(`  stories  ${rows.length}\n`);

  let exported = 0;
  let skipped = 0;
  const failures: Array<{ row: Row; why: string }> = [];

  if (!verifyOnly) {
    for (const row of rows) {
      try {
        if (await alreadyGood(row)) {
          skipped++;
          continue;
        }
        await exportOne(row);
        exported++;
        if (exported % 25 === 0) console.info(`  … ${exported} exported`);
      } catch (error) {
        failures.push({ row, why: error instanceof Error ? error.message : String(error) });
      }
    }
    console.info(`  exported ${exported}, already present ${skipped}, failed ${failures.length}\n`);
  }

  // -------------------------------------------------------------------------
  // The verification. This is the half that matters: it asks the database what
  // ought to exist, not MinIO what it thinks it sent.
  // -------------------------------------------------------------------------
  const missing: Row[] = [];
  const wrongSize: Array<{ row: Row; actual: number }> = [];
  const corrupt: Array<{ row: Row; why: string }> = [];
  let verified = 0;

  for (const row of rows) {
    let info;
    try {
      info = await stat(pathFor(row.storageKey));
    } catch {
      missing.push(row);
      continue;
    }
    if (!info.isFile()) {
      missing.push(row);
      continue;
    }
    if (info.size !== row.fileSize) {
      wrongSize.push({ row, actual: info.size });
      continue;
    }
    const why = await looksLikeAModel(pathFor(row.storageKey), info.size);
    if (why) {
      corrupt.push({ row, why });
      continue;
    }
    verified++;
  }

  let orphans = 0;
  try {
    const keys = await listAllKeys();
    const referenced = new Set(rows.map((r) => r.storageKey));
    for (const k of keys) if (!referenced.has(k)) orphans++;
  } catch {
    orphans = -1;
  }

  console.info("  ── verification, against the database ─────────────────────");
  console.info(`  verified          ${verified} / ${rows.length}`);
  console.info(`  missing           ${missing.length}`);
  console.info(`  wrong size        ${wrongSize.length}`);
  console.info(`  not a model       ${corrupt.length}`);
  console.info(
    `  unreferenced objects left in the bucket  ${orphans < 0 ? "(could not list)" : orphans}`,
  );

  for (const r of missing.slice(0, 10)) console.info(`    MISSING     PPP-${100 + r.id}  ${r.storageKey}`);
  for (const w of wrongSize.slice(0, 10)) console.info(`    SIZE        PPP-${100 + w.row.id}  expected ${w.row.fileSize}, got ${w.actual}`);
  for (const c of corrupt.slice(0, 10)) console.info(`    CONTENT     PPP-${100 + c.row.id}  ${c.why}`);
  for (const f of failures.slice(0, 10)) console.info(`    EXPORT      PPP-${100 + f.row.id}  ${f.why}`);

  const bad = missing.length + wrongSize.length + corrupt.length + failures.length;
  if (bad > 0) {
    console.error(
      `\n  ${bad} model(s) unaccounted for. NOTHING has been removed — MinIO's\n` +
        "  data directory is untouched and the app is still reading from it.\n" +
        "  Fix the cause and run this again; it will only redo what is wrong.\n",
    );
    await db.$disconnect();
    process.exit(1);
  }

  console.info(
    `\n  All ${rows.length} model(s) are on the filesystem and readable.\n` +
      "  MinIO's data directory has not been touched. Keep it until the app has\n" +
      "  been switched over and you are satisfied.\n",
  );
  await db.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await db.$disconnect();
  process.exit(1);
});
