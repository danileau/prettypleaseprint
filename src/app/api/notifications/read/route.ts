import { jsonBody, ok, withActor } from "@/lib/api";
import { listNotifications, markNotificationsRead } from "@/lib/notifications";
import { StoryProblem } from "@/lib/stories";

/**
 * Mark one notification read, or the whole feed with an empty body.
 *
 * Answers with the number of rows it actually changed and the unread count
 * that is left, so a caller can tell "already read" from "not yours" without
 * either of them being an error — passing somebody else's id is a no-op, not
 * a 404, because a 404 here would be an oracle for whose notification is
 * whose.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withActor(async (request, actor) => {
  const body = await jsonBody(request);

  if (body.id !== undefined && typeof body.id !== "string") {
    throw new StoryProblem(400, "`id` must be a notification id, or be left out.");
  }

  const changed = await markNotificationsRead(actor, body.id);
  const { unread } = await listNotifications(actor, { limit: 1 });
  return ok({ changed, unread });
});
