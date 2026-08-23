import { Resend } from "resend";
import nodemailer from "nodemailer";

import { isBuildPhase } from "@/lib/runtime";

/**
 * Transport is picked once, at module load, in this order:
 *   RESEND_API_KEY -> Resend
 *   SMTP_URL       -> nodemailer (docker compose brings up Mailpit on :1025)
 *   neither        -> console (development only; refuses to start in prod)
 */
type Transport = "resend" | "smtp" | "console";

const transport: Transport = process.env.RESEND_API_KEY
  ? "resend"
  : process.env.SMTP_URL
    ? "smtp"
    : "console";

// A deployment with nowhere to send mail cannot invite anyone or sign anyone
// in, so it refuses to start rather than failing silently at the worst moment.
// The build is exempt: see src/lib/runtime.ts.
if (transport === "console" && process.env.NODE_ENV === "production" && !isBuildPhase) {
  throw new Error(
    "No mail transport configured. Set RESEND_API_KEY or SMTP_URL — this app " +
      "cannot deliver invitations or sign-in links without one.",
  );
}

const from = process.env.MAIL_FROM ?? "Pretty Please Print <printer@example.org>";

export type Mail = { to: string; subject: string; html: string; text: string };

export async function sendMail(mail: Mail): Promise<void> {
  switch (transport) {
    case "resend": {
      const resend = new Resend(process.env.RESEND_API_KEY!);
      const { error } = await resend.emails.send({ from, ...mail });
      if (error) throw new Error(`Resend refused the message: ${error.message}`);
      return;
    }
    case "smtp": {
      const t = nodemailer.createTransport(process.env.SMTP_URL!);
      await t.sendMail({ from, ...mail });
      return;
    }
    case "console": {
      // eslint-disable-next-line no-console
      console.info(
        `\n──────── mail (dev) ────────\nto:      ${mail.to}\nsubject: ${mail.subject}\n\n${mail.text}\n────────────────────────────\n`,
      );
      return;
    }
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

export function magicLinkEmail(opts: {
  to: string;
  url: string;
  expiresInMinutes: number;
}): Mail {
  return {
    to: opts.to,
    subject: "Your sign-in link",
    text:
      `Sign in to Pretty Please Print: ${opts.url}\n\n` +
      `The link works once and expires in ${opts.expiresInMinutes} minutes. ` +
      `If you did not ask for it, ignore this message.`,
    html: shell(
      "OPEN &middot; COME ON IN",
      `<h1 style="margin:0 0 14px;font-family:${SLAB};font-size:29px;line-height:1.1;color:${INK}">Sign in</h1>
       <p style="margin:0 0 20px">
         Here&rsquo;s the link you asked for. It signs you in on this device and
         then stops working.
       </p>
       ${button(opts.url, "Sign in")}
       <p style="margin:20px 0 0;padding:9px 13px;background:${SUN};border:2px solid ${INK};border-radius:999px;display:inline-block;font-family:${MONO};font-size:11px;font-weight:bold;letter-spacing:1px;color:${INK}">
         ONE USE &middot; EXPIRES IN ${opts.expiresInMinutes} MINUTES
       </p>
       <p style="margin:18px 0 0;font-family:${SANS};font-size:13.5px;color:${INK_2}">
         Didn&rsquo;t ask for this? Ignore it — nobody can sign in without the link.
         Tired of waiting for these? Save a passkey once you&rsquo;re in.
       </p>
       ${fallback(opts.url)}`,
    ),
  };
}
