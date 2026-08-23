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
  INVALID_TOKEN: "That link is no longer valid. Ask the printer owner for a fresh one.",
  TOKEN_EXPIRED: "That link expired. Ask the printer owner for another.",
  banned: "That account has been suspended.",
};

/** Set by /set-password once a new one has been chosen. */
const PASSWORD_SET = "Password saved. Sign in with it.";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; reset?: string }>;
}) {
  const { next, error, reset } = await searchParams;

  const user = await currentUser();
  if (user) redirect(safeNext(next));

  return (
    <AuthShell>
      <Kicker>Members only · ask at the counter</Kicker>
      <H1>What&rsquo;ll it be?</H1>
      <Lead>
        Use the passkey on this device, or your username and password.
      </Lead>

      {reset && (
        <div className="mb-[22px]">
          <Notice tone="good">{PASSWORD_SET}</Notice>
        </div>
      )}

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
