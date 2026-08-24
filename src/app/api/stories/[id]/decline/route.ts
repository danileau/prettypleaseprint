import { ok, storyResource, withActor } from "@/lib/api";
import { declineStory, getStory, storyIdOr400 } from "@/lib/stories";

/**
 * Say no. Terminal, and only reachable from `Requested` — once the printer
 * owner has said yes, saying no is a conversation, not a state change. A
 * decline from anywhere else is 403, carrying the sentence that says why.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withActor<{ id: string }>(
  async (_request, actor, { id }) => {
    const storyId = storyIdOr400(id);
    const done = await declineStory(actor, storyId);
    return ok({
      story: storyResource(await getStory(actor, storyId)),
      moved: { from: done.from, to: done.to },
      notified: done.uploaderName,
    });
  },
  { admin: true },
);
