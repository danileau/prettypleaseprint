import { fail, jsonBody, ok, storyResource, withActor } from "@/lib/api";
import { fetchImportable, importSourcesOrRefuse } from "@/lib/import";
import { checkWish, openRequest } from "@/lib/intake";
import { getStory } from "@/lib/stories";
import { BUSY_COPY, acquireSlot, releaseSlot } from "@/lib/upload-slots";

/**
 * Open a request from a file on a model site, instead of an upload.
 *
 * The body is the wish an upload carries, plus `url` (the model's page) and
 * `fileId` (one of the files `POST /api/import/files` listed for it). The
 * server fetches that file itself and from there it is an upload in every
 * respect: `src/lib/intake.ts` inspects the bytes, stores them and opens the
 * ticket, and does not care what the site said the file was.
 *
 * The wish is checked before anything is fetched — a colour that is off the
 * shelf should not cost a 200 MB download to find out — and the fetch takes one
 * of the same slots an upload does, because it holds the same memory.
 *
 * The address fetched is never the caller's choice; `src/lib/import.ts` sets
 * out how.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withActor(async (request, actor) => {
  // Before the body is even read: an instance with importing off says so,
  // whatever it was sent.
  importSourcesOrRefuse();

  const body = await jsonBody(request);
  const checked = await checkWish({
    title: body.title ?? "",
    material: body.material,
    colorName: body.colorName,
    quantity: body.quantity,
    priority: body.priority ?? undefined,
    tip: body.tip,
    note: body.note ?? "",
    printSettings: body.printSettings ?? "",
  });

  if (!(await acquireSlot())) return fail(503, BUSY_COPY);
  try {
    const fetched = await fetchImportable(body.url, body.fileId);
    const opened = await openRequest(actor, checked, fetched.name, fetched.bytes, {
      source: fetched.listing.source,
      url: fetched.listing.model.url,
    });
    return ok({ story: storyResource(await getStory(actor, opened.id)) }, 201);
  } finally {
    releaseSlot();
  }
});
