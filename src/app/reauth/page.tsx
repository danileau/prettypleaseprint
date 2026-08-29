import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { requireUser } from "@/lib/authz";
import { isFreshAuth } from "@/lib/reauth";
import { AuthShell, H1, Kicker, Lead } from "@/components/ui";
import { ReauthForm } from "./reauth-form";

/**
 * Same rule as the sign-in page: only a same-origin absolute path survives, so
 * this cannot be dressed up as a way to bounce somebody off-site.
 */
function safeNext(raw: string | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

/**
 * "Confirm it's you" before the actions that move access around.
 *
 * Reached only by being sent here from one of those actions — see
 * `requireFreshAuth` in `src/lib/reauth.ts`. Anyone whose sign-in is already
 * recent enough is bounced straight back, so landing here by hand does not
 * make you do anything twice.
 */
export default async function ReauthPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const target = safeNext(next);

  // You have to be somebody before you can prove you are still them.
  const user = await requireUser(`/reauth?next=${encodeURIComponent(target)}`);
  if (await isFreshAuth()) redirect(target);

  const row = await db.user.findUnique({
    where: { id: user.id },
    select: { username: true, displayUsername: true },
  });

  return (
    <AuthShell>
      <Kicker>One more time, please</Kicker>
      <H1>Is that still you?</H1>
      <Lead>
        You are about to change who can get in. A password or a passkey confirms
        it is you at the keyboard and not a browser somebody left open.
      </Lead>

      <ReauthForm
        next={target}
        username={row?.username ?? ""}
        displayUsername={row?.displayUsername ?? row?.username ?? ""}
      />
    </AuthShell>
  );
}
