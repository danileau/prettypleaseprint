import { jsonBody, ok, storyResource, withActor } from "@/lib/api";
import { changeStoryPriority, getStory, storyIdOr400 } from "@/lib/stories";

/**
 * Set how much a print matters: `{ "priority": "low" | "medium" | "high" }`.
 *
 * Unlike the status, this *is* set rather than derived — there is no order to
 * skip a step of, and the person asking is the one who knows. The requester
 * may change their own ticket and the printer owner any; someone else's is a
 * 404 through the scope. Refused with 409 once the ticket is Done or Declined.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withActor<{ id: string }>(async (request, actor, params) => {
  const id = storyIdOr400(params.id);
  const body = await jsonBody(request);
  const done = await changeStoryPriority(actor, id, body.priority);
  return ok({
    story: storyResource(await getStory(actor, id)),
    changed: { from: done.from, to: done.to, unchanged: done.unchanged },
  });
});
