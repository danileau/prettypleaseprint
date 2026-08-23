"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { db } from "@/lib/db";
import { record } from "@/lib/audit";
import { notify, printerOwner, requireUser, storyRef } from "@/lib/authz";
import { storyScope } from "@/lib/scope";

/**
 * Say something on a ticket.
 *
 * Both sides may write here — it is the one place in the app where the client
 * has something to do besides upload and wait. Which is exactly why the
 * visibility check matters: the story is loaded through `storyScope`, so a
 * client posting another person's story id finds nothing and is told the
 * ticket does not exist. Not "you may not", which would confirm it does.
 *
 * The notification goes to the *other* side. Nobody needs telling about
 * their own comment, and a feed full of your own words is a feed people
 * stop reading.
 */

const CommentSchema = z.object({
  storyId: z.coerce.number().int().positive(),
  body: z
    .string()
    .trim()
    .min(1, "Say something first.")
    .max(2000, "That is longer than a comment wants to be."),
});

function back(storyId: number, params: Record<string, string>): never {
  redirect(`/story/${storyId}?${new URLSearchParams(params).toString()}`);
}

export async function addComment(formData: FormData): Promise<void> {
  const actor = await requireUser();

  const parsed = CommentSchema.safeParse({
    storyId: formData.get("storyId"),
    body: formData.get("body"),
  });
  if (!parsed.success) {
    const id = Number(formData.get("storyId"));
    const message = parsed.error.issues[0]?.message ?? "Check that again.";
    if (Number.isInteger(id) && id > 0) back(id, { error: message });
    redirect("/board");
  }
  const { storyId, body } = parsed.data;

  // Scoped exactly like the story page: a client can only reach their own.
  const story = await db.story.findFirst({
    where: { AND: [{ id: storyId }, storyScope(actor)] },
    select: { id: true, title: true, uploaderId: true },
  });
  if (!story) redirect("/board");

  await db.comment.create({
    data: { storyId: story.id, authorId: actor.id, body },
  });

  // Whoever is not the author. An admin writing tells the uploader; a client
  // writing tells the printer owner.
  const recipientId =
    actor.role === "admin" ? story.uploaderId : (await printerOwner())?.id;

  if (recipientId && recipientId !== actor.id) {
    await notify({
      recipientId,
      storyId: story.id,
      text: `${actor.name.split(" ")[0]} commented on “${story.title}”.`,
    });
  }

  await record({
    action: "comment.added",
    actor,
    subject: storyRef(story.id),
    detail: { title: story.title, length: body.length },
  });

  revalidatePath(`/story/${story.id}`);
  back(story.id, { toast: "Sent" });
}
