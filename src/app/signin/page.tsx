import { redirect } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { currentUser } from "@/lib/authz";
import { AuthShell, H1, Kicker, Lead, Notice } from "@/components/ui";
import { SignInForm } from "./signin-form";
import { safeRedirect } from "@/lib/safe-redirect";
import { CLIENT_GROUPS } from "@/i18n/client-groups";
import { getClientMessages } from "@/i18n/server";
import { authMethods, oidcConfig } from "@/lib/auth-methods";

/**
 * The `?error=` codes this page explains, and which message explains each.
 *
 * The codes are other people's — Better Auth's, and this app's invite hook —
 * and arrive in the URL, so they are looked up in this table and never used
 * to build a message key: `?error=` is whatever a link says it is. Own-property
 * only, so `?error=toString` gets the generic sentence like any other unknown.
 */
const ERRORS = {
  invite_required: "inviteRequired",
  INVALID_TOKEN: "invalidToken",
  TOKEN_EXPIRED: "tokenExpired",
  banned: "suspended",
  BANNED_USER: "suspended",
  // Single sign-on. The provider vouching for the address is what stands in
  // for a password here, so "it has not" is its own sentence rather than a
  // shrug — it is the one of these somebody can go and fix.
  account_not_linked: "accountNotLinked",
  email_not_verified: "emailNotVerified",
  email_not_found: "emailNotFound",
  unable_to_get_user_info: "providerUnverified",
} as const;

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; reset?: string }>;
}) {
  const { next, error, reset } = await searchParams;

  const user = await currentUser();
  if (user) redirect(safeRedirect(next));

  const t = await getTranslations("signin");
  const shell = await getTranslations("authShell");
  const waysIn = await getTranslations("waysIn");

  const methods = authMethods();
  const sso = oidcConfig();
  const ssoName = sso ? (sso.name ?? waysIn("sso.defaultName")) : null;

  return (
    <AuthShell sign={shell("sign")}>
      <Kicker>{t("kicker")}</Kicker>
      <H1>{t("title")}</H1>
      <Lead>
        {!methods.local
          ? t("leadSsoOnly", { name: ssoName ?? waysIn("sso.defaultName") })
          : ssoName
            ? t("leadSso", { name: ssoName })
            : t("lead")}
      </Lead>

      {reset && (
        <div className="mb-[22px]">
          {/* Set by /set-password once a new one has been chosen. */}
          <Notice tone="good">{t("passwordSet")}</Notice>
        </div>
      )}

      {error && (
        <div className="mb-[22px]">
          <Notice tone="warn">
            {t(`errors.${Object.hasOwn(ERRORS, error) ? ERRORS[error as keyof typeof ERRORS] : "other"}`)}
          </Notice>
        </div>
      )}

      <NextIntlClientProvider messages={await getClientMessages(CLIENT_GROUPS.signin)} timeZone="UTC">
        <SignInForm next={safeRedirect(next)} local={methods.local} ssoName={ssoName} />
      </NextIntlClientProvider>
    </AuthShell>
  );
}
