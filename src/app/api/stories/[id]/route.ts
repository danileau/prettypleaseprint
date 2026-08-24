import { ok, storyResource, withActor } from "@/lib/api";
import { getStory, storyIdOr400, withdrawStory } from "@/lib/stories";

/**
 * One ticket, and taking it back.
 *
 * `GET` is scoped: a client naming somebody else's id is answered 404, not
 * 403, because a 403 would confirm the ticket exists. That is the same
 * decision the story page makes, through the same `storyScope` fragment.
 *
 * `DELETE` is the requester withdrawing their own request, and is refused
 * once the printer owner has started on it. The printer owner cannot delete
 * somebody's ticket through it either — being able to see every story is not
 * being allowed to withdraw one. Both rules are `withdrawStory`'s, so the
 * form and this endpoint cannot disagree.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withActor<{ id: string }>(async (_request, actor, { id }) => {
  const story = await getStory(actor, storyIdOr400(id));
  return ok(storyResource(story));
});

export const DELETE = withActor<{ id: string }>(async (_request, actor, { id }) => {
  const done = await withdrawStory(actor, storyIdOr400(id));
  return ok({ withdrawn: true, id: done.id, ref: done.ref, wasStatus: done.wasStatus });
});
