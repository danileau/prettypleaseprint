import Link from "next/link";

import { db } from "@/lib/db";
import { nextStatus, storyRef } from "@/lib/scope";
import { printerName, requireAdmin } from "@/lib/authz";
import { formatBytes } from "@/lib/models";
import { quantityText, relativeTime } from "@/lib/catalog";
import { AppHeader } from "@/components/app-header";
import { AdminActions } from "@/components/admin-actions";
import { Kicker, Notice, StatusChip } from "@/components/ui";
import { Toast } from "@/components/toast";

export const dynamic = "force-dynamic";

/**
 * The pass — the printer owner's home. Handoff §5.
 *
 * Two halves, because they answer different questions. "Waiting on you" is
 * the only part that needs a decision, so it comes first, is the loudest
 * thing on the page, and disappears entirely when it is empty. Everything
 * already accepted is a list you scan rather than act on, with one button
 * each to move it along.
 *
 * Admin-only: `requireAdmin` answers 404, so a client learns nothing about
 * whether this route exists.
 */
export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ toast?: string; error?: string }>;
}) {
  const [{ toast, error }, admin] = await Promise.all([searchParams, requireAdmin()]);
  const owner = await printerName();

  const stories = await db.story.findMany({
    orderBy: { createdAt: "asc" },
    include: { uploader: { select: { name: true, initials: true } } },
  });

  const waiting = stories.filter((s) => s.status === "Requested");
  const working = stories.filter(
    (s) => s.status !== "Requested" && s.status !== "Declined",
  );

  return (
    <>
      <AppHeader user={admin} active="/queue" />

      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <Kicker>Printer view · the machine by the window</Kicker>
        <h1 className="m-0 mb-[11px] text-[46px] leading-[0.95] text-ink">
          {owner}&rsquo;s queue
        </h1>
        <p className="m-0 mb-[26.4px] text-[16.5px] leading-[1.5] text-ink-2">
          {waiting.length
            ? `${waiting.length} ${waiting.length === 1 ? "ticket is" : "tickets are"} waiting for a yes.`
            : "Nothing waiting. Enjoy the quiet."}
        </p>

        {error && (
          <div className="mb-[22px] max-w-[640px]">
            <Notice tone="warn">{error}</Notice>
          </div>
        )}

        {/* ---- the only part that needs a decision ---- */}
        {waiting.length > 0 && (
          <section className="mb-[26.4px] overflow-hidden rounded-panel border-[3px] border-ink bg-sun shadow-stamp-lg">
            <div className="layers border-b-[3px] border-ink px-[22px] py-[11px]">
              <h2 className="m-0 font-display text-[20px] text-ink">Waiting on you</h2>
            </div>
            <div className="flex flex-col gap-[13.2px] p-[17.6px]">
              {waiting.map((story) => (
                <article
                  key={story.id}
                  className="flex flex-wrap items-start gap-[17.6px] rounded-card border-[3px] border-ink bg-porcelain p-[15px]"
                >
                  <div className="min-w-[220px] flex-[1_1_280px]">
                    <p className="m-0 font-mono text-[11.5px] font-bold tracking-[0.06em] text-ink-3">
                      {storyRef(story.id)} · {story.filename} · {formatBytes(story.fileSize)}
                    </p>
                    <Link
                      href={`/story/${story.id}`}
                      className="mt-[4px] block font-display text-[20px] leading-[1.15] text-ink hover:text-cherry-dk"
                    >
                      {story.title}
                    </Link>
                    <p className="m-0 mt-[6px] text-[14px] text-ink-2">
                      {quantityText(story.quantity)} · {story.material} ·{" "}
                      {story.colorName} · offers {story.tip}
                    </p>
                    <p className="m-0 mt-[4px] font-mono text-[11.5px] uppercase tracking-[0.05em] text-ink-3">
                      {story.uploader.name} · {relativeTime(story.createdAt)}
                    </p>
                  </div>
                  <AdminActions
                    storyId={story.id}
                    status={story.status}
                    flagged={story.flagged}
                    flagReason={story.flagReason}
                    from="/queue"
                    compact
                  />
                </article>
              ))}
            </div>
          </section>
        )}

        {/* ---- everything already said yes to ---- */}
        <h2 className="m-0 mb-[13.2px] font-display text-[24px] text-ink">
          Rest of the queue
        </h2>
        <div className="overflow-hidden rounded-panel border-[3px] border-ink bg-porcelain shadow-stamp">
          {working.length === 0 ? (
            <p className="m-0 p-[22px] font-mono text-[12px] uppercase tracking-[0.06em] text-ink-3">
              Nothing on the go.
            </p>
          ) : (
            working.map((story, i) => (
              <div
                key={story.id}
                className={`flex flex-wrap items-center gap-[15px] p-[15px] ${
                  i < working.length - 1 ? "border-b-2 border-dashed border-rule" : ""
                }`}
              >
                <span
                  aria-hidden
                  className="h-[40px] w-[40px] flex-none rounded-full border-[3px] border-ink"
                  style={{ background: story.colorHex }}
                />
                <div className="min-w-[180px] flex-[1_1_240px]">
                  <Link
                    href={`/story/${story.id}`}
                    className="block font-display text-[17px] leading-[1.2] text-ink hover:text-cherry-dk"
                  >
                    {story.title}
                  </Link>
                  <p className="m-0 mt-[3px] font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">
                    {story.filename} · {story.uploader.name} ·{" "}
                    {relativeTime(story.createdAt)}
                  </p>
                </div>
                <StatusChip status={story.status} />
                {story.flagged && (
                  <span className="rounded-chip border-2 border-ink bg-cherry px-[9px] py-[2px] font-mono text-[10.5px] font-bold uppercase text-ink">
                    needs a look
                  </span>
                )}
                <span className="w-[120px] font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">
                  {story.tip}
                </span>
                {nextStatus(story.status) && (
                  <AdminActions
                    storyId={story.id}
                    status={story.status}
                    flagged={story.flagged}
                    flagReason={story.flagReason}
                    from="/queue"
                    compact
                  />
                )}
              </div>
            ))
          )}
        </div>
      </main>

      {toast && <Toast>{toast}</Toast>}
    </>
  );
}
