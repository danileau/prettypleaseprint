import { redirect } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";

import { db } from "@/lib/db";
import { requireUser } from "@/lib/authz";
import { isFreshAuth } from "@/lib/reauth";
import { AuthShell, H1, Kicker, Lead, Notice } from "@/components/ui";
import { ReauthForm } from "./reauth-form";
import { safeRedirect } from "@/lib/safe-redirect";
import { authMethods, oidcConfig } from "@/lib/auth-methods";
import { CLIENT_GROUPS } from "@/i18n/client-groups";
import { getClientMessages } from "@/i18n/server";

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
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const target = safeRedirect(next);

  // You have to be somebody before you can prove you are still them.
  const user = await requireUser(`/reauth?next=${encodeURIComponent(target)}`);
  if (await isFreshAuth()) redirect(target);

  // Only what single sign-on adds to this screen reads the catalogue so far;
  // the rest of it moves when the screen does (docs/i18n.md).
  const t = await getTranslations("reauth");
  const waysIn = await getTranslations("waysIn");
  const methods = authMethods();
  const sso = oidcConfig();
  const ssoName = sso ? (sso.name ?? waysIn("sso.defaultName")) : null;

  const row = await db.user.findUnique({
    where: { id: user.id },
    select: { username: true, displayUsername: true },
  });

  return (
    <AuthShell>
      <Kicker>One more time, please</Kicker>
      <H1>Is that still you?</H1>
      <Lead>
        {methods.local
          ? t("lead")
          : t("leadSso", { name: ssoName ?? waysIn("sso.defaultName") })}
      </Lead>

      {/* A confirmation through the provider that came back refused — most
          often one that answered from the session it held instead of asking
          again (`ssoProfile` in src/lib/oidc-flow.ts). */}
      {error && ssoName && (
        <div className="mb-[22px]">
          <Notice tone="warn">{t("ssoNotConfirmed", { name: ssoName })}</Notice>
        </div>
      )}

      <NextIntlClientProvider messages={await getClientMessages(CLIENT_GROUPS.reauth)} timeZone="UTC">
        <ReauthForm
          next={target}
          username={row?.username ?? ""}
          displayUsername={row?.displayUsername ?? row?.username ?? ""}
          local={methods.local}
          ssoLabel={ssoName ? t("withSso", { name: ssoName }) : null}
        />
      </NextIntlClientProvider>
    </AuthShell>
  );
}
