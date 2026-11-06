import { getTranslations } from "next-intl/server";

import { authMethods } from "@/lib/auth-methods";
import { requireAdmin } from "@/lib/authz";
import { db } from "@/lib/db";
import { mailPreview, mailPreviewNames, mailStatus, voiceFor } from "@/lib/email";
import { AppHeader } from "@/components/app-header";
import { Button, Kicker, Notice } from "@/components/ui";
import { Toast } from "@/components/toast";
import { sendTestMailAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Mail — where it goes, whether it gets there, and what it says.
 *
 * Three questions an owner has about mail and, until this page, no way to
 * answer without causing a real event: *is it set up*, *does it actually
 * arrive*, and *what are people being sent in my name*. An invitation that
 * silently never arrives looks, from the guest list, exactly like one that did.
 *
 * Read-only apart from the test message. The transport is environment, not a
 * setting: it carries a credential, and a credential belongs in the file the
 * host already protects rather than in a form on a web page.
 */
export default async function MailPage({
  searchParams,
}: {
  searchParams: Promise<{ test?: string; locale?: string }>;
}) {
  const user = await requireAdmin();
  const { test, locale } = await searchParams;
  const t = await getTranslations("adminMail");
  // What the test message came to (./actions.ts), from a fixed set of codes.
  // A refusal is worded with what the mail server said, read from this
  // owner's own latest failure on the trail — never from the URL.
  const refusal =
    test === "refused"
      ? await db.auditEvent.findFirst({
          where: { action: "mail.test_failed", actorId: user.id },
          orderBy: { at: "desc" },
          select: { detail: true },
        })
      : null;
  const reason = (refusal?.detail as { reason?: unknown } | null)?.reason;
  const toast = test === "sent" ? t("result.sent", { email: user.email }) : null;
  const error =
    test === "none"
      ? t("result.none")
      : test === "refused"
        ? t("result.refused", { reason: typeof reason === "string" ? reason : t("result.noReason") })
        : null;
  const status = mailStatus();
  const on = status.transport !== "none";
  const passwords = authMethods().local;
  // The previews are written in a language of the owner's choosing — what
  // somebody who picked it on their profile is sent. English unless asked.
  const voice = await voiceFor(locale);
  const inLocale = voice.lang === "en" ? "" : `?locale=${encodeURIComponent(voice.lang)}`;
  const server =
    status.server === null
      ? t("noTransport")
      : status.server.kind === "resend"
        ? "Resend"
        : status.server.kind === "smtp-unparsable"
          ? t("badUrl")
          : `${status.server.host}${status.server.port ? `:${status.server.port}` : ""} (${status.server.tls ? t("tls") : t("starttls")})`;
  const mono = (chunks: React.ReactNode) => <span className="font-mono">{chunks}</span>;

  return (
    <>
      <AppHeader user={user} active="/admin/mail" />
      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        {toast && <Toast>{toast}</Toast>}
        <div className="max-w-[780px]">
          <Kicker>{t("kicker")}</Kicker>
          <h1 className="m-0 mb-[13.2px] text-[46px] leading-[0.98] text-ink">{t("title")}</h1>
          <p className="m-0 mb-[26.4px] text-[16.5px] leading-[1.5] text-ink-2 text-pretty">
            {t("intro", { passwords: passwords ? "on" : "off" })}
          </p>

          {error && (
            <div className="mb-[22px]">
              <Notice tone="warn">{error}</Notice>
            </div>
          )}

          {/* ---- where it goes ---- */}
          <section
            aria-labelledby="mail-status"
            className="rounded-panel border-[3px] border-ink bg-porcelain p-[22px] shadow-stamp"
          >
            <h2 id="mail-status" className="m-0 mb-[13.2px] font-display text-[22px] text-ink">
              {on ? t("on") : t("off")}
            </h2>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-[22px] gap-y-[8.8px] text-[15px]">
              <dt className="font-mono text-[11.5px] font-bold uppercase tracking-[0.08em] text-ink-3">{t("sentThrough")}</dt>
              <dd className="m-0 font-bold text-ink" data-mail-transport={status.transport}>
                {server}
              </dd>
              <dt className="font-mono text-[11.5px] font-bold uppercase tracking-[0.08em] text-ink-3">{t("sentAs")}</dt>
              <dd className="m-0 break-words font-bold text-ink">{status.from}</dd>
            </dl>
            <p className="m-0 mt-[13.2px] text-[13.5px] leading-[1.5] text-ink-2">
              {t.rich("fromEnv", { mono })}
            </p>

            <form action={sendTestMailAction} className="mt-[17.6px] flex flex-wrap items-center gap-[13.2px]">
              <Button type="submit" variant="secondary" disabled={!on}>
                {t("sendTest")}
              </Button>
              <span className="text-[13.5px] text-ink-2">
                {on ? t("goesTo", { email: user.email }) : t("setTransport")}
              </span>
            </form>
          </section>

          {/* ---- what it says ---- */}
          <h2 className="m-0 mb-[13.2px] mt-[35.2px] font-display text-[26px] text-ink">{t("previewsTitle")}</h2>
          <p className="m-0 mb-[17.6px] text-[15px] leading-[1.5] text-ink-2">
            {t("previewsIntro")}
          </p>
          <div className="flex flex-col gap-[13.2px]">
            {mailPreviewNames(passwords).map((name) => {
              const mail = mailPreview(name, voice, passwords)!;
              return (
                <article
                  key={name}
                  className="rounded-panel border-[3px] border-ink bg-porcelain p-[22px]"
                >
                  <h3 className="m-0 font-display text-[19px] text-ink">{t(`previews.${name}.label`)}</h3>
                  <p className="m-0 mt-[4px] text-[14px] leading-[1.5] text-ink-2">{t(`previews.${name}.when`)}</p>
                  <p className="m-0 mt-[11px] font-mono text-[12px] uppercase tracking-[0.04em] text-ink-3">{t("subject")}</p>
                  <p className="m-0 break-words text-[15px] font-bold text-ink">{mail.subject}</p>
                  <p className="m-0 mt-[13.2px] flex flex-wrap gap-[17.6px] text-[14.5px] font-bold">
                    <a
                      href={`/admin/mail/preview/${name}${inLocale}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-cherry-dk underline underline-offset-4 hover:text-cherry"
                    >
                      {t("seeIt")}
                    </a>
                    <a
                      href={`/admin/mail/preview/${name}${inLocale ? `${inLocale}&` : "?"}as=text`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-ink-2 underline underline-offset-4 hover:text-cherry-dk"
                    >
                      {t("plainText")}
                    </a>
                  </p>
                </article>
              );
            })}
          </div>
        </div>
      </main>
    </>
  );
}
