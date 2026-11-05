import { currentUser } from "@/lib/authz";
import { authMethods } from "@/lib/auth-methods";
import { mailPreview, voiceFor } from "@/lib/email";

/**
 * One of the app's emails, exactly as it is sent, with stand-in data.
 *
 * A route rather than a page, for the reason `/docs` is: an email is a whole
 * document with its own table layout and inline styles, and the root layout
 * would wrap it in the app's. Served as itself, what the owner sees is the
 * markup a mail client gets.
 *
 * `?as=text` gives the plain-text alternative every message also carries —
 * the part a screen reader, a watch or a suspicious corporate gateway shows.
 *
 * `?locale=fr` writes it in that catalogue's language, as somebody who chose
 * it would get it; no locale, or one with no catalogue, is English. A preview
 * this deployment cannot send — a password reset with passwords off — is 404.
 *
 * Owner only, and 404 otherwise, like every other admin surface. The samples
 * are fixed and name nobody; nothing here reads the database.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404 });

export async function GET(request: Request, context: { params: Promise<{ name: string }> }) {
  const user = await currentUser();
  if (!user || user.role !== "admin") return notFound();

  const { name } = await context.params;
  const query = new URL(request.url).searchParams;
  const voice = await voiceFor(query.get("locale"));
  const mail = mailPreview(name, voice, authMethods().local);
  if (!mail) return notFound();

  if (query.get("as") === "text") {
    return new Response(`Subject: ${mail.subject}\n\n${mail.text}\n`, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const title = mail.subject.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c as "&" | "<" | ">"]);
  return new Response(
    `<!doctype html><html lang="${voice.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body style="margin:0">${mail.html}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}
