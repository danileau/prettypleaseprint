import "server-only";

import { db } from "@/lib/db";
import { notify, printerOwner, storyRef } from "@/lib/authz";
import type { Actor } from "@/lib/scope";
import { record } from "@/lib/audit";
import { WishSchema, type Wish } from "@/lib/catalog";
import { availableSelection } from "@/lib/catalog-data";
import { activeBenefitLabels } from "@/lib/benefits";
import { REJECTION_COPY, extensionOf, inspectModel, safeFilename } from "@/lib/models";
import { MIME_FOR, ensureStorageRoot, putModel, storageKeyFor } from "@/lib/storage";
import { StoryProblem } from "@/lib/stories";
import type { ImportSource } from "@/lib/import-source";

/**
 * Opening a request from a model's bytes — the part an upload and an import
 * have in common, once.
 *
 * It lived in the upload route while that was the only way a model arrived.
 * Importing from a link is a second door onto the same thing, and the reason
 * `stories.ts` exists applies here unchanged: a rule that lives in the caller
 * holds only for the caller that remembered it. Both doors now hand over a
 * name and some bytes, and everything that decides whether those become a
 * ticket is below.
 *
 * Order matters. Nothing is written to storage until the bytes have been
 * inspected, and no story row exists until the file is in place — so a
 * rejected file leaves nothing behind, and a story never points at a file
 * that was not stored.
 */

const problem = (status: number, message: string) => new StoryProblem(status, message);

export type CheckedWish = {
  wish: Wish;
  selection: NonNullable<Awaited<ReturnType<typeof availableSelection>>>;
};

/**
 * The wish, held to the rules — before any bytes are read or fetched.
 *
 * Separate from `openRequest` so each door can refuse a bad wish cheaply: an
 * import should not pull 200 MB across the internet to discover the colour is
 * off the shelf.
 */
export async function checkWish(raw: Record<string, unknown>): Promise<CheckedWish> {
  const parsed = WishSchema.safeParse(raw);
  if (!parsed.success) {
    throw problem(400, parsed.error.issues[0]?.message ?? "Check the form.");
  }
  const wish = parsed.data;

  const selection = await availableSelection(wish.material, wish.colorName);
  if (!selection) {
    throw problem(400, "That material and colour combination is no longer available.");
  }

  // The tip is owner-managed data, so the list — not a compile-time enum — is
  // what decides. A benefit the owner has retired, or one never on the list,
  // is refused here even if the form somehow posted it. If the owner has no
  // active benefits at all, any non-empty tip is accepted rather than locking
  // requests out.
  const allowedTips = await activeBenefitLabels();
  if (allowedTips.length > 0 && !allowedTips.includes(wish.tip)) {
    throw problem(400, "That is not a benefit on offer — pick one from the list.");
  }

  return { wish, selection };
}

/** Where a model came from, when it did not come from the requester's disk. */
export type Origin = { source: ImportSource; url: string };

let storageReady: Promise<void> | null = null;

/**
 * Inspect, store, open the ticket, tell the owner, write the trail.
 *
 * `rawName` is whatever the door was given — a browser's filename or the one a
 * model site lists — and is cleaned here, so neither door can forget to.
 */
export async function openRequest(
  actor: Actor,
  { wish, selection }: CheckedWish,
  rawName: string,
  bytes: Uint8Array,
  origin?: Origin,
) {
  const filename = safeFilename(rawName);

  // Authoritative check. Whatever the browser allowed through, and whatever a
  // model site says a file is, this is what decides — extension, size and
  // actual content all have to agree.
  const inspection = inspectModel(filename, bytes);
  if (!inspection.ok) {
    // A refused file creates no story, so it gets its own verb. Repeated
    // rejections from one account are worth being able to see.
    await record({
      action: "upload.rejected",
      actor,
      subject: filename,
      detail: {
        reason: inspection.reason,
        bytes: bytes.length,
        ...(origin ? { source: origin.source, sourceUrl: origin.url } : {}),
      },
    });
    throw problem(422, REJECTION_COPY[inspection.reason]);
  }

  const extension = extensionOf(filename);
  const key = storageKeyFor(extension);

  try {
    storageReady ??= ensureStorageRoot();
    await storageReady;
    await putModel(key, bytes);
  } catch (error) {
    storageReady = null; // let the next attempt retry creating the directory
    console.error("[intake] storage write failed", error);
    throw problem(502, "The file could not be stored. Try again in a moment.");
  }

  const title = wish.title || filename.replace(/\.(stl|3mf)$/i, "");

  let story;
  try {
    story = await db.story.create({
      data: {
        title,
        uploaderId: actor.id,
        status: "Requested",
        quantity: wish.quantity,
        priority: wish.priority,
        material: wish.material,
        colorName: wish.colorName,
        colorHex: selection.hex,
        colorStyle: selection.style,
        colorMode: selection.mode,
        tip: wish.tip,
        note: wish.note,
        printSettings: wish.printSettings,
        filename,
        fileSize: bytes.length,
        mimeType: MIME_FOR[extension] ?? "application/octet-stream",
        storageKey: key,
        dims: inspection.dims,
        sourceUrl: origin?.url ?? null,
      },
    });
  } catch (error) {
    console.error("[intake] story insert failed", error);
    throw problem(500, "The request could not be saved. Try again.");
  }

  // "every upload notifies the admin"
  const admin = await printerOwner();
  if (admin) {
    await notify({
      recipientId: admin.id,
      storyId: story.id,
      text: origin
        ? `${actor.name} imported “${title}”.`
        : `${actor.name} uploaded “${title}”.`,
    });
  }

  await record({
    action: "story.created",
    actor,
    subject: storyRef(story.id),
    detail: {
      title,
      filename,
      bytes: bytes.length,
      format: inspection.format,
      triangles: inspection.triangles,
      dims: inspection.dims,
      material: wish.material,
      quantity: wish.quantity,
      ...(origin ? { source: origin.source, sourceUrl: origin.url } : {}),
    },
  });

  return { id: story.id, ref: storyRef(story.id), title, dims: inspection.dims };
}
