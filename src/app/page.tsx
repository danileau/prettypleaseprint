import { redirect } from "next/navigation";
import { requireUser } from "@/lib/authz";

export const dynamic = "force-dynamic";

/**
 * Home differs by role, exactly as the handoff specifies: the printer owner
 * starts at the queue, because their job is deciding; everyone else starts at
 * the rail, because theirs is watching.
 */
export default async function Index() {
  const user = await requireUser("/");
  redirect(user.role === "admin" ? "/queue" : "/board");
}
