import { redirect } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { currentUser } from "@/lib/authz";
import { AuthShell, H1, Kicker, Lead, Notice } from "@/components/ui";
import { SignInForm } from "./signin-form";
import { safeRedirect } from "@/lib/safe-redirect";
import { CLIENT_GROUPS } from "@/i18n/client-groups";
import { getClientMessages } from "@/i18n/server";

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

  return (
    <AuthShell sign={shell("sign")}>
      <Kicker>{t("kicker")}</Kicker>
      <H1>{t("title")}</H1>
      <Lead>{t("lead")}</Lead>

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
        <SignInForm next={safeRedirect(next)} />
      </NextIntlClientProvider>
    </AuthShell>
  );
}
