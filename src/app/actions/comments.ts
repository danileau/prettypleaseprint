"use server";

import { redirect } from "next/navigation";

import { requireUser } from "@/lib/authz";
import { StoryProblem, addComment as post, IdSchema } from "@/lib/stories";

/**
 * The composer on a ticket, as a plain form.
 *
 * The scoping, the notification to the other side and the audit row are
 * `addComment`'s in `src/lib/stories.ts` — the API posts through the same
 * function. This is the adapter that turns a `FormData` into a redirect.
 */

function back(storyId: number, params: Record<string, string>): never {
  redirect(`/story/${storyId}?${new URLSearchParams(params).toString()}`);
}

export async function addComment(formData: FormData): Promise<void> {
  const actor = await requireUser();

  const parsedId = IdSchema.safeParse(formData.get("storyId"));
  if (!parsedId.success) redirect("/board");
  const storyId = parsedId.data;

  try {
    await post(actor, storyId, formData.get("body") ?? "");
  } catch (error) {
    if (error instanceof StoryProblem) {
      // 404 means the ticket is not theirs to see. Saying so on a page they
      // cannot reach would be a redirect into a wall, and naming it at all
      // would confirm it exists — so they go back to their own board.
      if (error.status === 404) redirect("/board");
      back(storyId, { error: error.message });
    }
    throw error;
  }

  back(storyId, { toast: "Sent" });
}
