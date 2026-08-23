import "server-only";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import type { Actor } from "@/lib/scope";

/**
 * The audit trail.
 *
 * Every action that changes who can get in, or what happens to someone's
 * model, writes a row here. Rows are never updated or deleted by the app.
 *
 * Two rules for callers:
 *   - Never pass a token, a password, a signed URL or file contents in
 *     `detail`. The trail is meant to be readable by whoever runs the
 *     printer, and a secret in a log is a secret in one more place.
 *   - Record after the change has committed, so the trail cannot claim
 *     something that did not happen.
 */
export type AuditAction =
  // access
  | "invite.sent"
  | "invite.resent"
  | "invite.revoked"
  | "invite.accepted"
  | "invite.rejected"
  | "auth.signed_in"
  | "auth.signed_out"
  | "user.role_changed"
  | "access.reissued"
  // work
  | "story.created"
  | "upload.rejected"
  | "story.status_changed"
  | "story.declined"
  | "story.flagged"
  | "story.flag_cleared"
  | "comment.added"
  | "file.downloaded"
  | "file.refused";

/**
 * Whether `X-Forwarded-For` can be believed.
 *
 * The header is set by whoever spoke to us last. Behind a reverse proxy that
 * is the proxy, and the value is the real client. Reachable directly — on a
 * LAN, say — it is whatever the caller typed, and recording that as fact would
 * put attacker-chosen strings in the audit trail and let someone frame another
 * address for their own refused attempts.
 *
 * So it is off unless the deployment says otherwise. Without it the trail
 * records no address rather than a fictional one, which is the more useful
 * failure: a blank is obviously a blank.
 */
const TRUST_PROXY = process.env.TRUST_PROXY_HEADERS === "true";

function clientIp(h: Headers): string | null {
  if (!TRUST_PROXY) return null;
  // Left-most entry is the original client as the first proxy saw it.
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || h.get("x-real-ip")?.trim() || null;
}

type RecordInput = {
  action: AuditAction;
  actor?: Actor | { id: string; email: string } | null;
  subject?: string | null;
  detail?: Record<string, unknown> | null;
};

/**
 * Best effort by design: a failure to write the trail must not fail the
 * action the user asked for. It is logged loudly instead, so a broken trail
 * is noisy rather than silent.
 */
export async function record(input: RecordInput): Promise<void> {
  try {
    let ip: string | null = null;
    let userAgent: string | null = null;
    try {
      const h = await headers();
      ip = clientIp(h);
      userAgent = h.get("user-agent")?.slice(0, 300) ?? null;
    } catch {
      // Outside a request (a cron, a seed) — the trail still gets the event.
    }

    await db.auditEvent.create({
      data: {
        action: input.action,
        actorId: input.actor?.id ?? null,
        actorEmail: input.actor?.email ?? null,
        subject: input.subject ?? null,
        ip,
        userAgent,
        detail: (input.detail ?? undefined) as never,
      },
    });
  } catch (error) {
    console.error("[audit] failed to record", input.action, error);
  }
}

/** Most recent events first. Admin-only — the caller gates access. */
export function recentEvents(limit = 100) {
  return db.auditEvent.findMany({
    orderBy: { at: "desc" },
    take: Math.min(limit, 500),
  });
}
