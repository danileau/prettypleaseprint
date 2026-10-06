import { requireAdmin } from "@/lib/authz";
import { MAIL_PREVIEWS, mailStatus } from "@/lib/email";
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
  searchParams: Promise<{ toast?: string; error?: string }>;
}) {
  const user = await requireAdmin();
  const { toast, error } = await searchParams;
  const status = mailStatus();
  const on = status.transport !== "none";

  return (
    <>
      <AppHeader user={user} active="/admin/mail" />
      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        {toast && <Toast>{toast}</Toast>}
        <div className="max-w-[780px]">
          <Kicker>Out the door</Kicker>
          <h1 className="m-0 mb-[13.2px] text-[46px] leading-[0.98] text-ink">Mail</h1>
          <p className="m-0 mb-[26.4px] text-[16.5px] leading-[1.5] text-ink-2 text-pretty">
            Invitations, password resets, and a copy of each notification for
            anyone who has not switched that off. Nothing here needs mail to
            work — without it you hand links over yourself and notifications
            stay in the Activity panel.
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
              {on ? "Mail is switched on" : "Mail is switched off"}
            </h2>
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-[22px] gap-y-[8.8px] text-[15px]">
              <dt className="font-mono text-[11.5px] font-bold uppercase tracking-[0.08em] text-ink-3">Sent through</dt>
              <dd className="m-0 font-bold text-ink" data-mail-transport={status.transport}>
                {status.server ?? "nothing — no SMTP_URL or RESEND_API_KEY is set"}
              </dd>
              <dt className="font-mono text-[11.5px] font-bold uppercase tracking-[0.08em] text-ink-3">Sent as</dt>
              <dd className="m-0 break-words font-bold text-ink">{status.from}</dd>
            </dl>
            <p className="m-0 mt-[13.2px] text-[13.5px] leading-[1.5] text-ink-2">
              These come from <span className="font-mono">.env.docker</span> on the
              host (<span className="font-mono">SMTP_URL</span> or{" "}
              <span className="font-mono">RESEND_API_KEY</span>, and{" "}
              <span className="font-mono">MAIL_FROM</span>), not from this page —
              they include a password.
            </p>

            <form action={sendTestMailAction} className="mt-[17.6px] flex flex-wrap items-center gap-[13.2px]">
              <Button type="submit" variant="secondary" disabled={!on}>
                Send me a test message
              </Button>
              <span className="text-[13.5px] text-ink-2">
                {on ? `Goes to ${user.email} and nowhere else.` : "Set a transport first."}
              </span>
            </form>
          </section>

          {/* ---- what it says ---- */}
          <h2 className="m-0 mb-[13.2px] mt-[35.2px] font-display text-[26px] text-ink">What people are sent</h2>
          <p className="m-0 mb-[17.6px] text-[15px] leading-[1.5] text-ink-2">
            Each message as it leaves, with stand-in names and links that go
            nowhere. Every one also carries a plain-text version, for mail
            clients that will not show the other.
          </p>
          <div className="flex flex-col gap-[13.2px]">
            {Object.entries(MAIL_PREVIEWS).map(([name, preview]) => {
              const mail = preview.build();
              return (
                <article
                  key={name}
                  className="rounded-panel border-[3px] border-ink bg-porcelain p-[22px]"
                >
                  <h3 className="m-0 font-display text-[19px] text-ink">{preview.label}</h3>
                  <p className="m-0 mt-[4px] text-[14px] leading-[1.5] text-ink-2">{preview.when}</p>
                  <p className="m-0 mt-[11px] font-mono text-[12px] uppercase tracking-[0.04em] text-ink-3">Subject</p>
                  <p className="m-0 break-words text-[15px] font-bold text-ink">{mail.subject}</p>
                  <p className="m-0 mt-[13.2px] flex flex-wrap gap-[17.6px] text-[14.5px] font-bold">
                    <a
                      href={`/admin/mail/preview/${name}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-cherry-dk underline underline-offset-4 hover:text-cherry"
                    >
                      See it as sent ↗
                    </a>
                    <a
                      href={`/admin/mail/preview/${name}?as=text`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-ink-2 underline underline-offset-4 hover:text-cherry-dk"
                    >
                      Plain-text version ↗
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
