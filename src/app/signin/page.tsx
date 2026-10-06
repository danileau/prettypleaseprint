import { redirect } from "next/navigation";
import { currentUser } from "@/lib/authz";
import { AuthShell, H1, Kicker, Lead, Notice } from "@/components/ui";
import { SignInForm } from "./signin-form";
import { safeRedirect } from "@/lib/safe-redirect";
import { authMethods, oidcConfig } from "@/lib/auth-methods";

const ERRORS: Record<string, string> = {
  invite_required:
    "That address has not been invited. Pretty Please Print is invite-only — ask whoever owns the printer for a link.",
  INVALID_TOKEN: "That link is no longer valid. Ask the printer owner for a fresh one.",
  TOKEN_EXPIRED: "That link expired. Ask the printer owner for another.",
  banned: "That account has been suspended. Ask whoever owns the printer.",
  BANNED_USER: "That account has been suspended. Ask whoever owns the printer.",
  // Single sign-on. The provider vouching for the address is what stands in
  // for a password here, so "it has not" is its own sentence rather than a
  // shrug — it is the one of these somebody can go and fix.
  account_not_linked:
    "There is an account for that address, but your sign-on provider has not confirmed the address is yours. Verify it there, then try again.",
  email_not_verified:
    "Your sign-on provider has not confirmed your email address, so it cannot vouch for who you are here. Verify it there, then try again.",
  email_not_found:
    "Your sign-on provider did not share an email address, so there is no way to tell who you are here.",
  unable_to_get_user_info:
    "Your sign-on provider's answer could not be verified, so nobody was signed in. Try again; if it keeps happening, tell whoever owns the printer.",
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
  if (user) redirect(safeRedirect(next));

  const methods = authMethods();
  const sso = oidcConfig();

  return (
    <AuthShell>
      <Kicker>Members only · ask at the counter</Kicker>
      <H1>What&rsquo;ll it be?</H1>
      <Lead>
        {!methods.local
          ? `Sign in with ${sso?.name ?? "single sign-on"} — the same login you use elsewhere.`
          : sso
            ? `Use ${sso.name}, the passkey on this device, or your username and password.`
            : "Use the passkey on this device, or your username and password."}
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

      <SignInForm next={safeRedirect(next)} local={methods.local} ssoName={sso?.name ?? null} />
    </AuthShell>
  );
}
