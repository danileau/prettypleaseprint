import { jsonBody, ok, storyResource, withActor } from "@/lib/api";
import { getStory, requeueStory, storyIdOr400 } from "@/lib/stories";

/**
 * Print one of your own tickets again, from the same file, with whatever you
 * want different this time.
 *
 * The body is the wish, and every field is optional: what is left out is
 * carried over from the old ticket, so `{}` repeats it exactly and
 * `{ "quantity": 4 }` asks for four of the same. What is sent is held to the
 * rules an upload is — the material and colour must be on the shelf today,
 * the tip must be a benefit on offer.
 *
 * Yours only. Someone else's ticket is 404 through `storyScope`, like every
 * other read; the printer owner can see every ticket and still gets 403 on
 * one they did not ask for, because seeing a request is not being the person
 * whose request it is to repeat.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withActor<{ id: string }>(async (request, actor, params) => {
  const id = storyIdOr400(params.id);
  const changes = await jsonBody(request);
  const done = await requeueStory(actor, id, changes);
  return ok({ story: storyResource(await getStory(actor, done.id)), from: done.fromRef }, 201);
});
