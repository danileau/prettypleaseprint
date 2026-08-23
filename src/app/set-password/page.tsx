import Link from "next/link";

import { readResetToken } from "@/lib/password-reset";
import { AuthShell, H1, Kicker, Lead, Notice } from "@/components/ui";
import { SetPasswordForm } from "./set-password-form";

export const dynamic = "force-dynamic";

/**
 * Where a set-password link lands.
 *
 * Reachable without a session on purpose — the whole point is that somebody
 * who cannot get in can get back in. It is not an authenticated surface and
 * grants nothing on its own: the token is checked here only to decide what to
 * render, and checked again for real when the form is submitted.
 */
export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const resolved = token ? await readResetToken(token) : null;

  if (!resolved) {
    return (
      <AuthShell>
        <Kicker>New key, cut fresh</Kicker>
        <H1>That link is spent</H1>
        <Lead>
          Set-password links work once and expire quickly. Ask whoever owns the
          printer for another — it takes them a moment.
        </Lead>
        <Link
          href="/signin"
          className="font-bold text-[15px] text-cherry-dk underline underline-offset-2 hover:text-cherry"
        >
          Go to sign in →
        </Link>
      </AuthShell>
    );
  }

  const { user } = resolved;
  const needsUsername = !user.username;

  return (
    <AuthShell>
      <Kicker>New key, cut fresh</Kicker>
      <H1>
        {needsUsername ? "Set yourself up" : `Pick a password, ${user.name.split(" ")[0]}`}
      </H1>
      <Lead>
        {needsUsername
          ? "Nobody invited this account, so it has no username yet. Pick one, and a password to go with it."
          : "This link sets a password and nothing else — you will sign in with it on the next screen. Anything you were signed in on with the old one is signed out."}
      </Lead>

      <SetPasswordForm token={token!} needsUsername={needsUsername} />

      <div className="mt-[22px]">
        <Notice>
          Did not ask for this? Have a word with whoever runs the printer before
          you use it.
        </Notice>
      </div>
    </AuthShell>
  );
}
