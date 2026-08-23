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
// Templates. Inline styles only — every mail client strips <style> blocks.
// Colours are the design tokens from the handoff.
// ---------------------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

function shell(body: string): string {
  return `<div style="margin:0;padding:35px 26px;background:#f4f5f6;font-family:'IBM Plex Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#14181c">
  <div style="max-width:520px;margin:0 auto">
    <div style="display:flex;align-items:center;gap:13px;margin-bottom:26px">
      <span style="display:inline-block;width:28px;height:28px;border-radius:999px;background:#12645f;vertical-align:middle"></span>
      <span style="font-size:18px;font-weight:600;letter-spacing:-0.01em;vertical-align:middle">pretty please print</span>
    </div>
    <div style="background:#ffffff;border-radius:14px;padding:35px 26px;box-shadow:0 1px 2px rgba(19,24,30,0.14)">${body}</div>
    <p style="margin:22px 0 0;font-size:12px;color:#6b747c;line-height:1.5">
      You are receiving this because someone at the office uses Pretty Please Print.
      If none of this means anything to you, ignore the message — nothing happens without the link above.
    </p>
  </div>
</div>`;
}

const button = (url: string, label: string) =>
  `<a href="${esc(url)}" style="display:inline-block;background:#12645f;color:#eef6f5;text-decoration:none;border-radius:8px;padding:15px 28px;font-size:16px;font-weight:700">${esc(label)}</a>`;

const fallback = (url: string) =>
  `<p style="margin:22px 0 0;font-size:12.5px;color:#6b747c;line-height:1.5;word-break:break-all">
    Button not working? Paste this into your browser:<br><span style="font-family:'IBM Plex Mono',ui-monospace,monospace">${esc(url)}</span>
  </p>`;

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
      `${opts.inviterName} added you to Pretty Please Print — upload an .stl or .3mf and it lands on the print backlog.\n\n` +
      `Claim your account: ${opts.url}\n\n` +
      `The link works once and expires in ${opts.expiresInDays} days.`,
    html: shell(`
      <h1 style="margin:0 0 13px;font-size:26px;font-weight:600;letter-spacing:-0.02em;line-height:1.15">You have been handed a 3D printer</h1>
      <p style="margin:0 0 22px;font-size:16px;line-height:1.5;color:#333b42">
        <strong>${esc(opts.inviterName)}</strong> added you to Pretty Please Print. Upload an
        <span style="font-family:'IBM Plex Mono',ui-monospace,monospace">.stl</span> or
        <span style="font-family:'IBM Plex Mono',ui-monospace,monospace">.3mf</span>, say what you are hoping for,
        and it turns up on the backlog as a story you can follow.
      </p>
      ${button(opts.url, "Claim your account")}
      <p style="margin:22px 0 0;font-size:13.5px;color:#6b747c">
        The link works once and expires in ${opts.expiresInDays} days. Only you can use it.
      </p>
      ${fallback(opts.url)}
    `),
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
    html: shell(`
      <h1 style="margin:0 0 13px;font-size:26px;font-weight:600;letter-spacing:-0.02em;line-height:1.15">Sign in</h1>
      <p style="margin:0 0 22px;font-size:16px;line-height:1.5;color:#333b42">
        Here is the link you asked for. It signs you in on this device and then stops working.
      </p>
      ${button(opts.url, "Sign in")}
      <p style="margin:22px 0 0;font-size:13.5px;color:#6b747c">
        Expires in ${opts.expiresInMinutes} minutes. If you did not ask for this, ignore it — nobody can sign in without the link.
      </p>
      ${fallback(opts.url)}
    `),
  };
}
