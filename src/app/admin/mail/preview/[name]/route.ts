import { currentUser } from "@/lib/authz";
import { MAIL_PREVIEWS, type MailPreviewName } from "@/lib/email";

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
  if (!Object.hasOwn(MAIL_PREVIEWS, name)) return notFound();
  const mail = MAIL_PREVIEWS[name as MailPreviewName].build();

  if (new URL(request.url).searchParams.get("as") === "text") {
    return new Response(`Subject: ${mail.subject}\n\n${mail.text}\n`, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const title = mail.subject.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body style="margin:0">${mail.html}</body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}
