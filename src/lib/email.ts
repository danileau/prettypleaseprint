import { Resend } from "resend";
import nodemailer from "nodemailer";

import { isBuildPhase } from "@/lib/runtime";

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
export function mailStatus(): { transport: Transport; from: string; server: string | null } {
  const transport = mailTransport();
  let server: string | null = null;
  if (transport === "smtp") {
    try {
      const url = new URL(process.env.SMTP_URL!);
      server = `${url.hostname}${url.port ? `:${url.port}` : ""} (${url.protocol === "smtps:" ? "TLS" : "STARTTLS if offered"})`;
    } catch {
      server = "SMTP_URL is set but is not a URL";
    }
  }
  if (transport === "resend") server = "Resend";
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

const fallback = (url: string) =>
  `<p style="margin:22px 0 0;font-family:${MONO};font-size:12px;color:${INK_2};line-height:1.6;word-break:break-all">
    Button not working? Paste this in:<br>${esc(url)}
  </p>`;

/**
 * @param banner  the mono uppercase strip across the top of the card
 */
function shell(banner: string, body: string): string {
  return `<div style="margin:0;padding:30px 16px;background:${CREAM}">
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
          <tr><td bgcolor="${AQUA}" style="padding:11px 26px;border-bottom:3px solid ${INK};font-family:${MONO};font-size:12px;font-weight:bold;letter-spacing:1.5px;color:${INK}">${banner}</td></tr>
          <tr><td style="padding:32px 26px;font-family:${SANS};font-size:16px;line-height:1.55;color:${INK}">${body}</td></tr>
          <tr><td style="font-size:0;line-height:0">${checkerRow()}</td></tr>
        </table>
      </td></tr>

      <tr><td style="padding-top:20px;font-family:${SANS};font-size:12px;line-height:1.6;color:${INK_2}">
        You are getting this because someone at the office runs a 3D printer and
        uses Pretty Please Print to keep track of who asked for what. If none of
        that means anything to you, ignore this — nothing happens without the
        link above.
      </td></tr>

    </table>
   </td></tr>
  </table>
</div>`;
}

export function inviteEmail(opts: {
  to: string;
  url: string;
  inviterName: string;
  expiresInDays: number;
}): Mail {
  return {
    to: opts.to,
    subject: `${opts.inviterName} is offering to print things for you`,
    text:
      `${opts.inviterName} added you to Pretty Please Print — drop an .stl or .3mf and it goes up on the rail as a ticket.\n\n` +
      `Claim your seat: ${opts.url}\n\n` +
      `The link works once and expires in ${opts.expiresInDays} days.`,
    html: shell(
      "YOUR TABLE IS READY",
      `<h1 style="margin:0 0 14px;font-family:${SLAB};font-size:29px;line-height:1.1;color:${INK}">You&rsquo;ve been handed a 3D printer</h1>
       <p style="margin:0 0 20px">
         <strong>${esc(opts.inviterName)}</strong> added you to Pretty Please Print.
         Drop an <span style="font-family:${MONO}">.stl</span> or
         <span style="font-family:${MONO}">.3mf</span>, say what you&rsquo;re hoping
         for, and it goes up on the rail as a ticket you can follow.
       </p>
       ${button(opts.url, "Claim your seat")}
       <p style="margin:20px 0 0;padding:9px 13px;background:${SUN};border:2px solid ${INK};border-radius:999px;display:inline-block;font-family:${MONO};font-size:11px;font-weight:bold;letter-spacing:1px;color:${INK}">
         ONE USE &middot; EXPIRES IN ${opts.expiresInDays} DAYS
       </p>
       ${fallback(opts.url)}`,
    ),
  };
}

export function passwordResetEmail(opts: {
  to: string;
  url: string;
  expiresInMinutes: number;
}): Mail {
  return {
    to: opts.to,
    subject: "Set a new password",
    text:
      `Someone with the keys to the printer reset your Pretty Please Print password.\n\n` +
      `Choose a new one: ${opts.url}\n\n` +
      `The link works once and expires in ${opts.expiresInMinutes} minutes. ` +
      `It does not sign you in — you pick a password, then use it. ` +
      `If you did not expect this, say so before you use it.`,
    html: shell(
      "NEW KEY &middot; ONE USE",
      `<h1 style="margin:0 0 14px;font-family:${SLAB};font-size:29px;line-height:1.1;color:${INK}">Set a new password</h1>
       <p style="margin:0 0 20px">
         Whoever runs the printer reset your password. This link lets you pick a
         new one — it does <strong>not</strong> sign you in on its own.
       </p>
       ${button(opts.url, "Choose a password")}
       <p style="margin:20px 0 0;padding:9px 13px;background:${SUN};border:2px solid ${INK};border-radius:999px;display:inline-block;font-family:${MONO};font-size:11px;font-weight:bold;letter-spacing:1px;color:${INK}">
         ONE USE &middot; EXPIRES IN ${opts.expiresInMinutes} MINUTES
       </p>
       <p style="margin:18px 0 0;font-family:${SANS};font-size:13.5px;color:${INK_2}">
         Didn&rsquo;t expect this? Have a word with them before you use it.
         Tired of typing a password? Save a passkey once you&rsquo;re back in.
       </p>
       ${fallback(opts.url)}`,
    ),
  };
}

/**
 * A notification, by mail.
 *
 * The same sentence the Activity panel shows, and a way to the ticket. It is a
 * copy, not the record: the panel has it whether or not this arrives, which is
 * why a failed send is logged and nothing else.
 *
 * `text` is written by this app but quotes what people typed — a title, a
 * reason — so it is escaped here like everything else that reaches the HTML.
 */
export function notificationEmail(opts: {
  to: string;
  recipientName: string;
  /** The notification, as the Activity panel words it. */
  text: string;
  /** Where to go, or null when what it was about is gone (a withdrawal). */
  url: string | null;
  /** "PPP-104", for the button and the subject. */
  ref: string | null;
  /** Where to switch these off. */
  settingsUrl: string;
}): Mail {
  const first = opts.recipientName.trim().split(/\s+/)[0] ?? opts.recipientName;
  return {
    to: opts.to,
    subject: opts.ref ? `${opts.ref}: ${opts.text}` : opts.text,
    text:
      `${opts.text}\n\n` +
      (opts.url ? `Open it: ${opts.url}\n\n` : "") +
      `You are getting this because email notifications are on for you in Pretty Please Print. ` +
      `Switch them off here: ${opts.settingsUrl}`,
    html: shell(
      opts.ref ? `ON THE RAIL &middot; ${esc(opts.ref)}` : "ON THE RAIL",
      `<p style="margin:0 0 6px;font-family:${MONO};font-size:12px;letter-spacing:1px;color:${INK_2}">HEY ${esc(first.toUpperCase())}</p>
       <h1 style="margin:0 0 20px;font-family:${SLAB};font-size:24px;line-height:1.2;color:${INK}">${esc(opts.text)}</h1>
       ${opts.url ? button(opts.url, opts.ref ? `Open ${opts.ref}` : "Open it") : ""}
       <p style="margin:22px 0 0;font-family:${SANS};font-size:13.5px;line-height:1.5;color:${INK_2}">
         It is in your Activity panel too. Rather not get these by email?
         <a href="${esc(opts.settingsUrl)}" style="color:${CHERRY_DK}">Switch them off</a>.
       </p>
       ${opts.url ? fallback(opts.url) : ""}`,
    ),
  };
}

/** A message that proves the transport works, and says so when it arrives. */
export function testEmail(opts: { to: string; sentBy: string }): Mail {
  return {
    to: opts.to,
    subject: "Test message from Pretty Please Print",
    text:
      `This is a test message, sent by ${opts.sentBy} from the Mail page.\n\n` +
      `If you are reading it, invitations, password resets and notifications can reach people.`,
    html: shell(
      "TEST &middot; NOTHING TO DO",
      `<h1 style="margin:0 0 14px;font-family:${SLAB};font-size:29px;line-height:1.1;color:${INK}">Mail is getting through</h1>
       <p style="margin:0">
         This is a test message, sent by <strong>${esc(opts.sentBy)}</strong> from the
         Mail page. If you are reading it, invitations, password resets and
         notifications can reach people.
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
 */
export const MAIL_PREVIEWS = {
  invitation: {
    label: "Invitation",
    when: "Sent when you invite somebody, and when you resend it.",
    build: () =>
      inviteEmail({
        to: "ayla@office.example",
        url: "https://print.example/invite/sample-link-not-a-real-one",
        inviterName: "Ruben Haas",
        expiresInDays: 7,
      }),
  },
  "password-reset": {
    label: "Password reset",
    when: "Sent when you press “Forgotten password?” against somebody on the guest list.",
    build: () =>
      passwordResetEmail({
        to: "ayla@office.example",
        url: "https://print.example/set-password?token=sample-link-not-a-real-one",
        expiresInMinutes: 30,
      }),
  },
  notification: {
    label: "Notification",
    when:
      "Sent for everything that also lands in the Activity panel — a new request, a ticket moving, a comment — to people who have not switched it off.",
    build: () =>
      notificationEmail({
        to: "ayla@office.example",
        recipientName: "Ayla Berg",
        text: "Ruben moved “Hook for the monitor arm” to Printing.",
        url: "https://print.example/story/4",
        ref: "PPP-104",
        settingsUrl: "https://print.example/me#email",
      }),
  },
  test: {
    label: "Test message",
    when: "Sent to you, from this page.",
    build: () => testEmail({ to: "you@office.example", sentBy: "Ruben Haas" }),
  },
} as const satisfies Record<string, { label: string; when: string; build: () => Mail }>;

export type MailPreviewName = keyof typeof MAIL_PREVIEWS;
