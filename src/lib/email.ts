import { Resend } from "resend";
import nodemailer from "nodemailer";

import { isBuildPhase } from "@/lib/runtime";
import { catalogueFor, translatorFor, type Messages, type Translator } from "@/i18n/catalogue";

/**
 * Where mail goes, if anywhere:
 *   RESEND_API_KEY -> Resend
 *   SMTP_URL       -> nodemailer (compose brings up Mailpit on :1025)
 *   neither        -> nowhere, and that is a supported mode
 *
 * Read per call rather than fixed at module load, so the answer cannot go
 * stale against the environment and a test can flip it.
 */
type Transport = "resend" | "smtp" | "none";

export function mailTransport(): Transport {
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.SMTP_URL) return "smtp";
  return "none";
}

/**
 * Is there anywhere to send mail?
 *
 * Running without one is a supported mode, not a broken deployment. Mail
 * delivers two kinds of thing: a link — an invitation, or a password reset —
 * and a copy of a notification that is in the Activity panel either way. With
 * no transport the app hands the admin the link to pass on directly, and
 * notifications simply stay in the app. For a group that shares an office that is arguably the
 * better channel: a token in an inbox sits there indefinitely and can be
 * forwarded; one handed over in person cannot.
 *
 * This used to throw in production. It no longer does — refusing to start was
 * the wrong answer to a question the operator may have settled deliberately.
 */
export const mailConfigured = () => mailTransport() !== "none";

if (!isBuildPhase && process.env.NODE_ENV === "production" && !mailConfigured()) {
  console.info(
    "[mail] No transport configured. Invitations and password-reset links " +
      "will be shown to the admin to hand over, and notifications stay in the " +
      "Activity panel. Nothing needs mail to work.",
  );
}

const from = process.env.MAIL_FROM ?? "Pretty Please Print <printer@example.org>";

/**
 * What the owner is shown about where mail goes — and nothing they are not.
 *
 * The transport's kind, the sender, and for SMTP the host and port. Never the
 * URL itself: it carries the password, and a settings page is exactly where a
 * credential ends up in a screenshot.
 */
export type MailServer =
  | { kind: "smtp"; host: string; port: string; tls: boolean }
  | { kind: "smtp-unparsable" }
  | { kind: "resend" }
  | null;

export function mailStatus(): { transport: Transport; from: string; server: MailServer } {
  const transport = mailTransport();
  let server: MailServer = null;
  if (transport === "smtp") {
    try {
      const url = new URL(process.env.SMTP_URL!);
      server = { kind: "smtp", host: url.hostname, port: url.port, tls: url.protocol === "smtps:" };
    } catch {
      server = { kind: "smtp-unparsable" };
    }
  }
  if (transport === "resend") server = { kind: "resend" };
  return { transport, from, server };
}

export type Mail = { to: string; subject: string; html: string; text: string };

/**
 * Delivers, or reports that it could not. The caller decides what to do about
 * it — for an invitation, that means showing the link to the admin instead.
 */
export async function sendMail(mail: Mail): Promise<boolean> {
  switch (mailTransport()) {
    case "resend": {
      const resend = new Resend(process.env.RESEND_API_KEY!);
      const { error } = await resend.emails.send({ from, ...mail });
      if (error) throw new Error(`Resend refused the message: ${error.message}`);
      return true;
    }
    case "smtp": {
      // Bounded, because the defaults are not: nodemailer will wait two
      // minutes on a server that never answers. Notifications are sent without
      // being awaited, so an unreachable server would otherwise collect
      // sockets; and the owner pressing "send a test message" deserves an
      // answer before they have given up and gone to look at the logs.
      const t = nodemailer.createTransport({
        url: process.env.SMTP_URL!,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
      await t.sendMail({ from, ...mail });
      return true;
    }
    case "none":
      return false;
  }
}

// ---------------------------------------------------------------------------
// Templates
//
// Tables and solid colour, not the app's CSS.
//
// Email is a hostile rendering target: Outlook runs the Word engine, Gmail
// strips <style> and background-image, and almost nothing loads a webfont. So
// none of the diner treatment here leans on gradients, box-shadow, flexbox or
// Alfa Slab One — the character comes from what survives everywhere: heavy
// solid borders, bright fills, and a checkerboard built from real table cells.
//
// Headings fall back to Georgia, which is the closest ubiquitous face to the
// slab used in the app. It is not the same, and that is the correct trade:
// a message that renders is worth more than one that matches.
//
// The palette is the app's, and so is its rule — bright fills carry dark ink,
// except cherry-dark, which carries cream.
//
// The words are the catalogue's (`mail.*` in messages/en.json), in the
// recipient's language: each template takes a translator, and the callers
// below build it from the person the message is for — never from whoever
// caused it. Every value that reaches the HTML is escaped here, before it is
// handed to the message: `t.markup` fills a message in, it does not escape.
// ---------------------------------------------------------------------------

const CREAM = "#fff6e9";
const INK = "#221a14";
const INK_2 = "#55483e";
const CHERRY_DK = "#b7231f";
const AQUA = "#14b3ae";
const SUN = "#f5b227";

const SANS = "Archivo,'Helvetica Neue',Helvetica,Arial,sans-serif";
const SLAB = "Georgia,'Times New Roman',serif";
const MONO = "'Courier New',Courier,monospace";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** The tags the catalogue's mail messages may use, as inline-styled HTML. */
const tags = {
  strong: (chunks: string) => `<strong>${chunks}</strong>`,
  mono: (chunks: string) => `<span style="font-family:${MONO}">${chunks}</span>`,
};

/** The checkerboard floor, as alternating table cells — works in every client. */
function checkerRow(): string {
  const cells = Array.from({ length: 26 }, (_, i) =>
    `<td width="20" height="12" bgcolor="${i % 2 === 0 ? INK : "#ffffff"}" style="font-size:0;line-height:0">&nbsp;</td>`,
  ).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cells}</tr></table>`;
}

/** A button that survives Outlook: a table cell with a block-level anchor. */
function button(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td bgcolor="${CHERRY_DK}" style="border:3px solid ${INK};border-radius:999px">
      <a href="${esc(url)}" style="display:block;padding:14px 30px;font-family:${SANS};font-size:16px;font-weight:bold;color:${CREAM};text-decoration:none">${esc(label)}</a>
    </td>
  </tr></table>`;
}

const fallback = (t: Translator, url: string) =>
  `<p style="margin:22px 0 0;font-family:${MONO};font-size:12px;color:${INK_2};line-height:1.6;word-break:break-all">
    ${esc(t("mail.shell.fallback"))}<br>${esc(url)}
  </p>`;

const pill = (text: string) =>
  `<p style="margin:20px 0 0;padding:9px 13px;background:${SUN};border:2px solid ${INK};border-radius:999px;display:inline-block;font-family:${MONO};font-size:11px;font-weight:bold;letter-spacing:1px;color:${INK}">
         ${esc(text)}
       </p>`;

const heading = (text: string, { size = 29, lineHeight = 1.1, below = 14 } = {}) =>
  `<h1 style="margin:0 0 ${below}px;font-family:${SLAB};font-size:${size}px;line-height:${lineHeight};color:${INK}">${esc(text)}</h1>`;

/**
 * @param banner  the mono uppercase strip across the top of the card, as text
 */
function shell(t: Translator, lang: string, banner: string, body: string): string {
  return `<div lang="${esc(lang)}" style="margin:0;padding:30px 16px;background:${CREAM}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
   <tr><td align="center">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="max-width:520px">

      <tr><td align="center" style="padding-bottom:22px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="30" height="30" bgcolor="${CHERRY_DK}" style="border:3px solid ${INK};border-radius:999px;font-size:0;line-height:0">&nbsp;</td>
          <td style="padding-left:12px;font-family:${SLAB};font-size:23px;font-style:italic;color:${CHERRY_DK}">pretty please print</td>
        </tr></table>
      </td></tr>

      <tr><td bgcolor="#ffffff" style="border:3px solid ${INK};border-radius:14px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td bgcolor="${AQUA}" style="padding:11px 26px;border-bottom:3px solid ${INK};font-family:${MONO};font-size:12px;font-weight:bold;letter-spacing:1.5px;color:${INK}">${esc(banner)}</td></tr>
          <tr><td style="padding:32px 26px;font-family:${SANS};font-size:16px;line-height:1.55;color:${INK}">${body}</td></tr>
          <tr><td style="font-size:0;line-height:0">${checkerRow()}</td></tr>
        </table>
      </td></tr>

      <tr><td style="padding-top:20px;font-family:${SANS};font-size:12px;line-height:1.6;color:${INK_2}">
        ${esc(t("mail.shell.footer"))}
      </td></tr>

    </table>
   </td></tr>
  </table>
</div>`;
}

/** The language a mail is written in, and the words for it. */
export type MailVoice = { lang: string; t: Translator };

/** The voice for somebody whose language is `locale` (their `preferredLocale`). */
export async function voiceFor(locale: string | null | undefined): Promise<MailVoice> {
  const catalogue = await catalogueFor(locale);
  return { lang: catalogue.locale, t: translatorFor(catalogue) };
}

/**
 * The `?locale=` a link to a preview needs for it to be written in `lang`, as
 * the owner's Mail page shows it. Left off only when a preview with none is in
 * that language anyway — the instance default, else English — and never just
 * because `lang` is English: with DEFAULT_LOCALE set, a preview with no
 * locale is in that language, not English.
 */
export async function previewLocaleQuery(lang: string): Promise<string> {
  return lang === (await voiceFor(null)).lang ? "" : `?locale=${encodeURIComponent(lang)}`;
}

export function inviteEmail(
  { t, lang }: MailVoice,
  opts: { to: string; url: string; inviterName: string; expiresInDays: number },
): Mail {
  return {
    to: opts.to,
    subject: t("mail.invite.subject", { inviter: opts.inviterName }),
    text: t("mail.invite.text", { inviter: opts.inviterName, url: opts.url, days: opts.expiresInDays }),
    html: shell(
      t,
      lang,
      t("mail.invite.banner"),
      `${heading(t("mail.invite.heading"))}
       <p style="margin:0 0 20px">
         ${t.markup("mail.invite.lead", { inviter: esc(opts.inviterName), ...tags })}
       </p>
       ${button(opts.url, t("mail.invite.button"))}
       ${pill(t("mail.invite.pill", { days: opts.expiresInDays }))}
       ${fallback(t, opts.url)}`,
    ),
  };
}

export function passwordResetEmail(
  { t, lang }: MailVoice,
  opts: { to: string; url: string; expiresInMinutes: number },
): Mail {
  return {
    to: opts.to,
    subject: t("mail.reset.subject"),
    text: t("mail.reset.text", { url: opts.url, minutes: opts.expiresInMinutes }),
    html: shell(
      t,
      lang,
      t("mail.reset.banner"),
      `${heading(t("mail.reset.heading"))}
       <p style="margin:0 0 20px">
         ${t.markup("mail.reset.lead", tags)}
       </p>
       ${button(opts.url, t("mail.reset.button"))}
       ${pill(t("mail.reset.pill", { minutes: opts.expiresInMinutes }))}
       <p style="margin:18px 0 0;font-family:${SANS};font-size:13.5px;color:${INK_2}">
         ${esc(t("mail.reset.aside"))}
       </p>
       ${fallback(t, opts.url)}`,
    ),
  };
}

/**
 * What a notification says, as a message key and its values rather than a
 * sentence — so that the Activity panel can store it in English today, and an
 * email can say it in the recipient's language.
 */
export type NotificationKey = keyof Messages["notification"];

/**
 * The values each notification takes. A JSON import types its strings as
 * `string`, so the placeholders cannot be read off en.json by the compiler;
 * this lists them, every key of the catalogue's `notification` group must be
 * here (`satisfies`), and `verify:queue` holds the list to en.json's
 * placeholders. A call that leaves a value out then fails the typecheck.
 */
export const NOTIFICATION_VALUES = {
  storyUploaded: ["actor", "title"],
  storyImported: ["actor", "title"],
  storyMoved: ["actor", "title", "status"],
  storyDeclined: ["actor", "title"],
  storyFlagged: ["actor", "title", "reason"],
  storyFlagCleared: ["actor", "title"],
  storyWithdrawn: ["actor", "ref", "title"],
  storyRequeued: ["actor", "title"],
  storyPriority: ["actor", "title", "priority"],
  storyCommented: ["actor", "title"],
  featureFiled: ["actor", "title"],
  featureWithdrawn: ["actor", "ref", "title"],
  featurePriority: ["actor", "title", "priority"],
  featureMoved: ["actor", "title", "status"],
  featureDeclined: ["actor", "title"],
  featureCommented: ["actor", "title"],
} as const satisfies Record<NotificationKey, readonly string[]>;

export type NotificationMessage = {
  [K in NotificationKey]: {
    key: K;
    values: Record<(typeof NOTIFICATION_VALUES)[K][number], string>;
  };
}[NotificationKey];

export const notificationText = (t: Translator, message: NotificationMessage): string =>
  // The values are a closed set per key, checked where each notification is
  // raised; the catalogue's types cannot follow a key chosen at run time.
  (t as unknown as (key: string, values: Record<string, string>) => string)(
    `notification.${message.key}`,
    message.values,
  );

/**
 * A notification, by mail.
 *
 * The same thing the Activity panel says, in the recipient's language, and a
 * way to the ticket. It is a copy, not the record: the panel has it whether or
 * not this arrives, which is why a failed send is logged and nothing else.
 *
 * The values quote what people typed — a title, a reason — so they are escaped
 * like everything else that reaches the HTML.
 */
export function notificationEmail(
  { t, lang }: MailVoice,
  opts: {
    to: string;
    recipientName: string;
    message: NotificationMessage;
    /** Where to go, or null when what it was about is gone (a withdrawal). */
    url: string | null;
    /** "PPP-104", for the button and the subject. */
    ref: string | null;
    /** Where to switch these off. */
    settingsUrl: string;
  },
): Mail {
  const text = notificationText(t, opts.message);
  const first = opts.recipientName.trim().split(/\s+/)[0] || opts.recipientName;
  return {
    to: opts.to,
    subject: opts.ref ? t("mail.notification.subject", { ref: opts.ref, text }) : text,
    text:
      `${text}\n\n` +
      (opts.url ? `${t("mail.notification.textOpen", { url: opts.url })}\n\n` : "") +
      t("mail.notification.textWhy", { url: opts.settingsUrl }),
    html: shell(
      t,
      lang,
      opts.ref ? t("mail.notification.bannerRef", { ref: opts.ref }) : t("mail.notification.banner"),
      `<p style="margin:0 0 6px;font-family:${MONO};font-size:12px;letter-spacing:1px;color:${INK_2}">${esc(t("mail.notification.greeting", { name: first.toLocaleUpperCase(lang) }))}</p>
       ${heading(text, { size: 24, lineHeight: 1.2, below: 20 })}
       ${opts.url ? button(opts.url, opts.ref ? t("mail.notification.openRef", { ref: opts.ref }) : t("mail.notification.open")) : ""}
       <p style="margin:22px 0 0;font-family:${SANS};font-size:13.5px;line-height:1.5;color:${INK_2}">
         ${t.markup("mail.notification.aside", {
           link: (chunks) => `<a href="${esc(opts.settingsUrl)}" style="color:${CHERRY_DK}">${chunks}</a>`,
         })}
       </p>
       ${opts.url ? fallback(t, opts.url) : ""}`,
    ),
  };
}

/**
 * A message that proves the transport works, and says so when it arrives.
 * `passwords` is whether this deployment has any to reset (`AUTH_METHODS`):
 * the message names only the mail the instance can actually send.
 */
export function testEmail(
  { t, lang }: MailVoice,
  opts: { to: string; sentBy: string; passwords: boolean },
): Mail {
  const passwords = opts.passwords ? "on" : "off";
  return {
    to: opts.to,
    subject: t("mail.test.subject"),
    text: t("mail.test.text", { sender: opts.sentBy, passwords }),
    html: shell(
      t,
      lang,
      t("mail.test.banner"),
      `${heading(t("mail.test.heading"))}
       <p style="margin:0">
         ${t.markup("mail.test.lead", { sender: esc(opts.sentBy), passwords, ...tags })}
       </p>`,
    ),
  };
}

/**
 * Every message this app can send, with stand-in data — for the owner's Mail
 * page, which shows each one so the wording and the look can be judged without
 * having to cause the event that sends it.
 *
 * The samples are fixed and name nobody real. A preview built from live data
 * would put a working invitation link on an admin screen.
 *
 * `passwords` (whether `AUTH_METHODS` has `local`) decides which exist: with
 * passwords off there is no reset to send, so there is none to preview.
 */
const PREVIEWS = {
  invitation: (voice: MailVoice) =>
    inviteEmail(voice, {
      to: "ayla@office.example",
      url: "https://print.example/invite/sample-link-not-a-real-one",
      inviterName: "Ruben Haas",
      expiresInDays: 7,
    }),
  "password-reset": (voice: MailVoice) =>
    passwordResetEmail(voice, {
      to: "ayla@office.example",
      url: "https://print.example/set-password?token=sample-link-not-a-real-one",
      expiresInMinutes: 30,
    }),
  notification: (voice: MailVoice) =>
    notificationEmail(voice, {
      to: "ayla@office.example",
      recipientName: "Ayla Berg",
      message: {
        key: "storyMoved",
        values: { actor: "Ruben", title: "Hook for the monitor arm", status: "Printing" },
      },
      url: "https://print.example/story/4",
      ref: "PPP-104",
      settingsUrl: "https://print.example/me#email",
    }),
  test: (voice: MailVoice, passwords: boolean) =>
    testEmail(voice, { to: "you@office.example", sentBy: "Ruben Haas", passwords }),
} as const satisfies Record<string, (voice: MailVoice, passwords: boolean) => Mail>;

export type MailPreviewName = keyof typeof PREVIEWS;

/** The previews this deployment can send, in the order the Mail page lists them. */
export function mailPreviewNames(passwords: boolean): MailPreviewName[] {
  return (Object.keys(PREVIEWS) as MailPreviewName[]).filter(
    (name) => passwords || name !== "password-reset",
  );
}

/** One preview, or null for a name that is not one (or not one here). */
export function mailPreview(name: string, voice: MailVoice, passwords: boolean): Mail | null {
  if (!(mailPreviewNames(passwords) as string[]).includes(name)) return null;
  return PREVIEWS[name as MailPreviewName](voice, passwords);
}
