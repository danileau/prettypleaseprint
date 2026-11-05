import { getTranslations } from "next-intl/server";

import { db } from "@/lib/db";
import { authMethods, oidcConfig } from "@/lib/auth-methods";
import { currentIssuerAccounts } from "@/lib/oidc-flow";
import { Button, Kicker, Notice } from "@/components/ui";
import { connectSsoAction, disconnectSsoAction } from "./actions";

/**
 * The printer owner's link to the single sign-on provider: whether there is
 * one, and the buttons to make or remove it. Rendered for the owner only, and
 * only where single sign-on is on. The words are read here, on the server —
 * nobody else sees them, so none are sent to a client component.
 */
export async function SsoPanel({ userId, email, status }: { userId: string; email: string; status?: string }) {
  const sso = oidcConfig();
  if (!sso) return null;
  const t = await getTranslations("me.sso");
  const waysIn = await getTranslations("waysIn");
  const name = sso.name ?? waysIn("sso.defaultName");
  const local = authMethods().local;
  // Through the provider configured now: a link from before `OIDC_ISSUER`
  // changed opens nothing, so it is not a connection.
  const connected = (await db.account.count({ where: { userId, ...currentIssuerAccounts(sso.issuer) } })) > 0;

  const notices: Record<string, { tone: "good" | "warn" | "info"; text: string }> = {
    connected: { tone: "good", text: t("status.connected", { name }) },
    disconnected: { tone: "info", text: t("status.disconnected", { name }) },
    failed: { tone: "warn", text: t("status.failed", { name, email }) },
    kept: { tone: "warn", text: t("status.kept", { name }) },
    unavailable: { tone: "warn", text: t("status.unavailable", { name }) },
  };
  const notice = status && Object.hasOwn(notices, status) ? notices[status] : undefined;

  return (
    <section
      id="sso"
      className="mb-[35.2px] rounded-panel border-[3px] border-ink bg-porcelain p-[22px] shadow-stamp"
    >
      <Kicker>{t("kicker")}</Kicker>
      {notice && (
        <div className="mb-[13.2px]">
          <Notice tone={notice.tone}>{notice.text}</Notice>
        </div>
      )}
      {connected ? (
        <>
          <p className="m-0 mb-[13.2px] text-[15.5px] leading-[1.5] text-ink">
            {t("connected", { name })}
          </p>
          {local ? (
            <form action={disconnectSsoAction}>
              <Button type="submit" variant="ghost">
                {t("disconnect", { name })}
              </Button>
            </form>
          ) : (
            <p className="m-0 text-[13.5px] leading-[1.5] text-ink-2">{t("onlyWayIn", { name })}</p>
          )}
        </>
      ) : (
        <>
          <p className="m-0 mb-[13.2px] text-[15.5px] leading-[1.5] text-ink">{t("notConnected", { name, email })}</p>
          <form action={connectSsoAction}>
            <Button type="submit" variant="secondary">
              {t("connect", { name })}
            </Button>
          </form>
          <p className="m-0 mt-[8.8px] text-[13.5px] leading-[1.5] text-ink-2">{t("connectNote", { email })}</p>
        </>
      )}
    </section>
  );
}
