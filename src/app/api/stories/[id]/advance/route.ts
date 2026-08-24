import { ok, storyResource, withActor } from "@/lib/api";
import { advanceStory, getStory, storyIdOr400 } from "@/lib/stories";

/**
 * Move a ticket one step along the flow.
 *
 * There is no "set the status to X" endpoint, and that is the design: the
 * flow is Requested → Accepted → Printing → Delivery → Done, forwards, one
 * step at a time, and an endpoint that took a target status would be an
 * invitation to skip one. The next state is derived, never supplied — the
 * body is ignored entirely.
 *
 * Answers 409 at the end of the line rather than pretending to succeed.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withActor<{ id: string }>(
  async (_request, actor, { id }) => {
    const storyId = storyIdOr400(id);
    const done = await advanceStory(actor, storyId);
    return ok({
      story: storyResource(await getStory(actor, storyId)),
      moved: { from: done.from, to: done.to },
      notified: done.uploaderName,
    });
  },
  { admin: true },
);
