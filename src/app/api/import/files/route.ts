import { jsonBody, ok, withActor } from "@/lib/api";
import { listImportable } from "@/lib/import";

/**
 * What a link to a model offers: the model, and the files in it that could be
 * printed.
 *
 * A model on a site like Printables usually carries several files and a
 * ticket holds one, so importing is two steps — this, and then
 * `POST /api/import` with the file that was picked.
 *
 * A POST although it changes nothing here, on purpose. It makes this server
 * call somebody else's, and a GET could be triggered from any page a signed-in
 * person happens to visit; as a POST it sits behind the same Origin check as
 * every write.
 *
 * `501` when the deployment has not switched importing on — see
 * `IMPORT_SOURCES` in `src/lib/import-source.ts`.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withActor(async (request) => {
  const body = await jsonBody(request);
  const listing = await listImportable(body.url);
  // Every field named, no spread — see `storyResource` in src/lib/api.ts.
  return ok({
    source: listing.source,
    model: {
      id: listing.model.id,
      name: listing.model.name,
      url: listing.model.url,
      author: listing.model.author,
      license: listing.model.license,
    },
    files: listing.files.map((file) => ({
      id: file.id,
      name: file.name,
      size: file.size,
      tooLarge: file.tooLarge,
    })),
    otherFiles: listing.otherFiles,
  });
});
