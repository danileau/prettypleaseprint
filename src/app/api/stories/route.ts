import { z } from "zod";

import { ok, storyResource, withActor } from "@/lib/api";
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  StatusSchema,
  StoryProblem,
  listStories,
} from "@/lib/stories";

/**
 * The tickets this caller may see, newest first.
 *
 * The same set the board and the queue draw from, and scoped by the same
 * `storyScope` fragment: a client sees their own requests, the printer owner
 * sees everything. The filters below can only ever narrow that — there is no
 * combination of query parameters that widens it, because the scope is the
 * first term of the AND and nothing here can reach it.
 *
 * Creating one is `POST /api/upload`, not here: a request arrives with a
 * model attached, and multipart is what carries 50 MB of geometry.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  status: z.array(StatusSchema).optional(),
  flagged: z.enum(["true", "false"]).optional(),
  mine: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).optional(),
  before: z.coerce.number().int().positive().optional(),
});

export const GET = withActor(async (request, actor) => {
  const url = new URL(request.url);

  // `?status=Requested&status=Printing` and `?status=Requested,Printing` both
  // work. Repeated keys are the OpenAPI convention; the comma form is what
  // people type into a terminal.
  const statuses = url.searchParams
    .getAll("status")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);

  const parsed = QuerySchema.safeParse({
    status: statuses.length ? statuses : undefined,
    flagged: url.searchParams.get("flagged") ?? undefined,
    mine: url.searchParams.get("mine") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    before: url.searchParams.get("before") ?? undefined,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StoryProblem(
      400,
      `${issue?.path.join(".") || "query"}: ${issue?.message ?? "not a valid filter."}`,
    );
  }

  const { stories, nextCursor } = await listStories(actor, {
    status: parsed.data.status,
    flagged: parsed.data.flagged === undefined ? undefined : parsed.data.flagged === "true",
    mine: parsed.data.mine === "true",
    limit: parsed.data.limit ?? LIST_LIMIT_DEFAULT,
    before: parsed.data.before,
  });

  return ok({
    stories: stories.map(storyResource),
    // Null on the last page. Feed it back as `?before=` for the next one.
    nextCursor,
  });
});
