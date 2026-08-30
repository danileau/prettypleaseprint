import { NextResponse } from "next/server";

import { db } from "@/lib/db";
import { currentUser, notify, printerOwner, storyRef } from "@/lib/authz";
import type { Actor } from "@/lib/scope";
import { record } from "@/lib/audit";
import { WishSchema, hexForColor } from "@/lib/catalog";
import { activeBenefitLabels } from "@/lib/benefits";
import {
  MAX_BYTES,
  REJECTION_COPY,
  extensionOf,
  inspectModel,
  safeFilename,
} from "@/lib/models";
import {
  MAX_CONCURRENT_UPLOADS,
  MAX_QUEUED_UPLOADS,
  MAX_REQUEST_BYTES,
} from "@/lib/upload-limits";
import { MIME_FOR, ensureBucket, putModel, storageKeyFor } from "@/lib/storage";

/**
 * Model upload.
 *
 * A route handler rather than a server action, for one reason: the browser
 * can watch a real XHR upload progress bar against this, and a large model
 * over office wifi is long enough that a spinner is not good enough.
 *
 * Order matters here. Nothing is written to storage until the bytes have
 * been inspected, and no story row exists until the object is in place — so
 * a rejected file leaves nothing behind, and a story never points at an
 * object that was not stored.
 */

export const runtime = "nodejs";
/** The whole file is buffered to measure its bounding box; do not cache. See
 *  the slot gate below for what keeps that buffering bounded. */
export const dynamic = "force-dynamic";

let bucketReady: Promise<void> | null = null;

const bad = (status: number, error: string) =>
  NextResponse.json({ error }, { status });

/**
 * Only so many uploads are handled at once.
 *
 * This is what makes a 250 MB cap safe rather than hopeful. `request.formData()`
 * buffers the whole body before a line of this handler runs, so peak memory is
 * decided by how many large uploads overlap — nothing the validator does can
 * change that. Bounding the overlap bounds the memory, which is the "size-based
 * queue" the security audit named as one of the two answers. (The other,
 * a streaming parse, needs the file to stop arriving as multipart at all; see
 * docs/architecture.md.)
 *
 * A late arrival waits rather than being refused: somebody who has just spent a
 * minute pushing 200 MB up office wifi should not be told to start again. Only
 * once the queue itself is long does the app say no, because at that point the
 * honest answer is that it is busy.
 *
 * Per process. A second app instance has its own gate, which is the right
 * shape anyway — the memory it is protecting is also per process.
 */
let active = 0;
const waiting: Array<() => void> = [];

function acquireSlot(): Promise<boolean> {
  if (active < MAX_CONCURRENT_UPLOADS) {
    active++;
    return Promise.resolve(true);
  }
  if (waiting.length >= MAX_QUEUED_UPLOADS) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    waiting.push(() => {
      active++;
      resolve(true);
    });
  });
}

function releaseSlot(): void {
  active--;
  waiting.shift()?.();
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return bad(401, "Sign in first.");

  // Cheap rejection before reading a single byte of the body. The allowance
  // over the file cap is multipart's own overhead, and it matches the
  // transport limit in next.config.ts so that a file just over the cap is
  // answered "too large" rather than truncated into a parse failure.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_REQUEST_BYTES) {
    return bad(413, REJECTION_COPY.too_large);
  }

  // Taken *before* the body is read, because reading it is the expensive part.
  if (!(await acquireSlot())) {
    return bad(
      503,
      "Too many uploads at once — give it a moment and send it again.",
    );
  }
  try {
    return await handleUpload(request, user);
  } finally {
    releaseSlot();
  }
}

async function handleUpload(request: Request, user: Actor) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad(400, "That upload did not arrive intact. Try again.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) return bad(400, "No file was attached.");
  if (file.size > MAX_BYTES) return bad(413, REJECTION_COPY.too_large);

  const wish = WishSchema.safeParse({
    title: form.get("title") ?? "",
    material: form.get("material"),
    colorName: form.get("colorName"),
    quantity: form.get("quantity"),
    tip: form.get("tip"),
    note: form.get("note") ?? "",
    printSettings: form.get("printSettings") ?? "",
  });
  if (!wish.success) {
    return bad(400, wish.error.issues[0]?.message ?? "Check the form.");
  }

  // The tip is owner-managed data, so the list — not a compile-time enum — is
  // what decides. A benefit the owner has retired, or one never on the list,
  // is refused here even if the form somehow posted it. If the owner has no
  // active benefits at all, any non-empty tip is accepted rather than locking
  // uploads out.
  const allowedTips = await activeBenefitLabels();
  if (allowedTips.length > 0 && !allowedTips.includes(wish.data.tip)) {
    return bad(400, "That is not a benefit on offer — pick one from the list.");
  }

  const filename = safeFilename(file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());

  // Authoritative check. Whatever the browser allowed through, this is what
  // decides — extension, size and actual content all have to agree.
  const inspection = inspectModel(filename, bytes);
  if (!inspection.ok) {
    // A refused upload creates no story, so it gets its own verb. Repeated
    // rejections from one account are worth being able to see.
    await record({
      action: "upload.rejected",
      actor: user,
      subject: filename,
      detail: { reason: inspection.reason, bytes: bytes.length },
    });
    return bad(422, REJECTION_COPY[inspection.reason]);
  }

  const extension = extensionOf(filename);
  const key = storageKeyFor(extension);

  try {
    bucketReady ??= ensureBucket();
    await bucketReady;
    await putModel(key, bytes, MIME_FOR[extension] ?? "application/octet-stream");
  } catch (error) {
    bucketReady = null; // let the next attempt retry the bucket check
    console.error("[upload] storage write failed", error);
    return bad(502, "The file could not be stored. Try again in a moment.");
  }

  const title = wish.data.title || filename.replace(/\.(stl|3mf)$/i, "");

  let story;
  try {
    story = await db.story.create({
      data: {
        title,
        uploaderId: user.id,
        status: "Requested",
        quantity: wish.data.quantity,
        material: wish.data.material,
        colorName: wish.data.colorName,
        colorHex: hexForColor(wish.data.colorName),
        tip: wish.data.tip,
        note: wish.data.note,
        printSettings: wish.data.printSettings,
        filename,
        fileSize: bytes.length,
        mimeType: MIME_FOR[extension] ?? "application/octet-stream",
        storageKey: key,
        dims: inspection.dims,
      },
    });
  } catch (error) {
    console.error("[upload] story insert failed", error);
    return bad(500, "The request could not be saved. Try again.");
  }

  // "every upload notifies the admin"
  const admin = await printerOwner();
  if (admin) {
    await notify({
      recipientId: admin.id,
      storyId: story.id,
      text: `${user.name} uploaded “${title}”.`,
    });
  }

  await record({
    action: "story.created",
    actor: user,
    subject: storyRef(story.id),
    detail: {
      title,
      filename,
      bytes: bytes.length,
      format: inspection.format,
      triangles: inspection.triangles,
      dims: inspection.dims,
      material: wish.data.material,
      quantity: wish.data.quantity,
    },
  });

  return NextResponse.json({
    id: story.id,
    ref: storyRef(story.id),
    title,
    dims: inspection.dims,
  });
}
