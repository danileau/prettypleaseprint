import { jsonBody, ok, storyResource, withActor } from "@/lib/api";
import { clearFlag, flagStory, getStory, storyIdOr400 } from "@/lib/stories";

/**
 * Flag a model problem, and clear it again.
 *
 * A flag does NOT change the status — the ticket is still wherever it was, it
 * just carries a note saying why it cannot proceed as-is. `reason` is required
 * and at least three characters, because "flagged" with no explanation tells
 * the person waiting nothing they can act on.
 *
 * `DELETE` is the way off. A flag with no way off is a dead end: the ticket
 * would carry "needs a look" for the rest of its life even after the model
 * was fixed.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withActor<{ id: string }>(
  async (request, actor, { id }) => {
    const storyId = storyIdOr400(id);
    const body = await jsonBody(request);
    const done = await flagStory(actor, storyId, body.reason);
    return ok({
      story: storyResource(await getStory(actor, storyId)),
      reason: done.reason,
      notified: done.uploaderName,
    });
  },
  { admin: true },
);

export const DELETE = withActor<{ id: string }>(
  async (_request, actor, { id }) => {
    const storyId = storyIdOr400(id);
    const done = await clearFlag(actor, storyId);
    return ok({
      story: storyResource(await getStory(actor, storyId)),
      notified: done.uploaderName,
    });
  },
  { admin: true },
);
