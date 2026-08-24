import { z } from "zod";

import { notificationResource, ok, withActor } from "@/lib/api";
import { NOTIFICATION_LIMIT_MAX, listNotifications } from "@/lib/notifications";
import { StoryProblem } from "@/lib/stories";

/**
 * Your Activity feed, newest first, with the unread count the header badge
 * shows. Yours and only yours — there is no parameter that names a recipient,
 * because the session already does.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  unread: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(NOTIFICATION_LIMIT_MAX).optional(),
});

export const GET = withActor(async (request, actor) => {
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    unread: url.searchParams.get("unread") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    throw new StoryProblem(400, parsed.error.issues[0]?.message ?? "Check that query.");
  }

  const { items, unread } = await listNotifications(actor, {
    unreadOnly: parsed.data.unread === "true",
    limit: parsed.data.limit,
  });

  return ok({ notifications: items.map(notificationResource), unread });
});
