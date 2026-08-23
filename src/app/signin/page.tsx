import { redirect } from "next/navigation";
import { currentUser } from "@/lib/authz";
import { AuthShell, H1, Kicker, Lead, Notice } from "@/components/ui";
import { SignInForm } from "./signin-form";

/**
 * Open redirects are how a phishing page borrows your domain's credibility.
 * Only same-origin, absolute-path targets survive this.
 */
function safeNext(raw: string | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

const ERRORS: Record<string, string> = {
  invite_required:
    "That address has not been invited. Pretty Please Print is invite-only — ask whoever owns the printer for a link.",
  INVALID_TOKEN: "That link is no longer valid. Ask for a fresh one below.",
  TOKEN_EXPIRED: "That link expired. Links last 10 minutes — here is another go.",
  banned: "That account has been suspended.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;

  const user = await currentUser();
  if (user) redirect(safeNext(next));

  return (
    <AuthShell>
      <Kicker>Invite only</Kicker>
      <H1>Sign in</H1>
      <Lead>
        No passwords here. Use the passkey on this device, or have a one-time
        link sent to your inbox.
      </Lead>

      {error && (
        <div className="mb-[22px]">
          <Notice tone="warn">
            {ERRORS[error] ?? "That sign-in attempt did not go through."}
          </Notice>
        </div>
      )}

      <SignInForm next={safeNext(next)} />
    </AuthShell>
  );
}
