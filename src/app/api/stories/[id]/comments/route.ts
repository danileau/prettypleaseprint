import { commentResource, jsonBody, ok, withActor } from "@/lib/api";
import { addComment, listComments, storyIdOr400 } from "@/lib/stories";

/**
 * The conversation on a ticket. Both sides may read and write it — it is the
 * one place in the app where the client has something to do besides upload
 * and wait.
 *
 * Which is exactly why the visibility check matters, and why it happens
 * before a single comment is read: the story is loaded through `storyScope`,
 * so a caller naming another person's story id is told the ticket does not
 * exist rather than "you may not", which would confirm it does.
 *
 * The notification goes to the other side, never to the author.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withActor<{ id: string }>(async (_request, actor, { id }) => {
  const comments = await listComments(actor, storyIdOr400(id));
  return ok({ comments: comments.map(commentResource) });
});

export const POST = withActor<{ id: string }>(async (request, actor, { id }) => {
  const body = await jsonBody(request);
  const comment = await addComment(actor, storyIdOr400(id), body.body);
  return ok(commentResource(comment), 201);
});
