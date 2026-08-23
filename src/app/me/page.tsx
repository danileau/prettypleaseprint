import Link from "next/link";

import { db } from "@/lib/db";
import { printerName, requireUser, storyScope } from "@/lib/authz";
import { storyRef } from "@/lib/scope";
import { formatBytes } from "@/lib/models";
import { relativeTime } from "@/lib/catalog";
import { AppHeader } from "@/components/app-header";
import { Kicker, StatusChip } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * The profile. Handoff §6.
 *
 * Everything on this page is scoped by the same rule as the board: a client
 * counts and lists only their own tickets, the printer owner sees the group.
 * The handoff calls this out explicitly, and it is the easiest place to leak
 * — a stat is still a fact about someone else's data.
 *
 * This is also where declined tickets finally surface. They are deliberately
 * off the rail, which left them reachable only by URL; the whole history
 * belongs here, including the parts that did not happen.
 */

type Card = { value: string; label: string; skin: string };

export default async function ProfilePage() {
  const user = await requireUser("/me");
  const owner = await printerName();
  const isAdmin = user.role === "admin";
  const scope = storyScope(user);

  const [stories, finished, beers, favourite, waiting, bytes] = await Promise.all([
    db.story.findMany({
      where: scope,
      orderBy: { createdAt: "desc" },
      include: { uploader: { select: { name: true, initials: true } } },
    }),
    db.story.count({ where: { AND: [scope, { status: { in: ["Done", "Delivery"] } }] } }),
    // A beer is owed once the work is actually done — not when it is asked for.
    db.story.count({
      where: { AND: [scope, { tip: "A beer" }, { status: { in: ["Done", "Delivery"] } }] },
    }),
    db.story.groupBy({
      by: ["material"],
      where: scope,
      _count: { material: true },
      orderBy: { _count: { material: "desc" } },
      take: 1,
    }),
    db.story.count({ where: { AND: [scope, { status: "Requested" }] } }),
    db.story.aggregate({
      where: { AND: [scope, { status: { in: ["Done", "Delivery"] } }] },
      _sum: { fileSize: true },
    }),
  ]);

  const inHand = stories.filter((s) => s.status === "Delivery").length;
  const usual = favourite[0]?.material ?? "—";

  /*
   * The handoff's admin card here is "Printer time given", and there is no
   * honest number behind it: print-time estimates were removed because a
   * figure derived from a bounding box is a guess dressed as a measurement.
   * Rather than invent one, this counts something real — how much geometry
   * has actually come off the plate. Swap it back the day a slicer is wired
   * in and the hours are known rather than assumed.
   */
  const cards: Card[] = isAdmin
    ? [
        { value: String(finished), label: "Printed for the group", skin: "bg-aqua" },
        { value: String(waiting), label: "Waiting on you", skin: "bg-sun" },
        { value: formatBytes(bytes._sum.fileSize ?? 0), label: "Geometry off the plate", skin: "bg-cream-2" },
        { value: String(beers), label: "Beers owed to you", skin: "bg-mint" },
      ]
    : [
        { value: String(stories.length), label: "Requests made", skin: "bg-aqua" },
        { value: String(inHand), label: "In your hands", skin: "bg-mint" },
        { value: String(beers), label: `Beers owed to ${owner}`, skin: "bg-sun" },
        { value: usual, label: "Your usual material", skin: "bg-cream-2" },
      ];

  return (
    <>
      <AppHeader user={user} active="/me" />

      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <div className="mb-[35.2px] flex flex-wrap items-center gap-[22px]">
          <span
            aria-hidden
            className="flex h-[92px] w-[92px] flex-none items-center justify-center rounded-full border-[3px] border-ink bg-aqua font-mono text-[30px] font-bold text-ink shadow-stamp-lg"
          >
            {user.initials}
          </span>
          <div>
            <Kicker>{isAdmin ? "Behind the counter" : "At the counter"}</Kicker>
            <h1 className="m-0 mb-[6px] text-[38px] leading-[1] text-ink">
              {user.name}
            </h1>
            <p className="m-0 text-[15.5px] text-ink-2">
              {isAdmin
                ? "Owns the printer, sees every ticket"
                : `Invited by ${owner} · sees only their own tickets`}
            </p>
          </div>
        </div>

        <div className="mb-[35.2px] grid grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-[13.2px]">
          {cards.map((c) => (
            <div
              key={c.label}
              className={`rounded-panel border-[3px] border-ink ${c.skin} p-[17.6px] shadow-stamp`}
            >
              <p className="m-0 font-display text-[36px] leading-[1] text-ink">
                {c.value}
              </p>
              <p className="m-0 mt-[8px] font-mono text-[11.5px] font-bold uppercase tracking-[0.06em] text-ink">
                {c.label}
              </p>
            </div>
          ))}
        </div>

        <h2 className="m-0 mb-[13.2px] font-display text-[26px] text-ink">
          {isAdmin ? "Everything the group has sent you" : "Your orders"}
        </h2>

        <div className="overflow-hidden rounded-panel border-[3px] border-ink bg-porcelain shadow-stamp">
          {stories.length === 0 ? (
            <p className="m-0 p-[22px] font-mono text-[12px] uppercase tracking-[0.06em] text-ink-3">
              {isAdmin ? "Nobody has sent you anything yet." : "No orders yet."}
            </p>
          ) : (
            stories.map((story, i) => (
              <div
                key={story.id}
                className={`flex flex-wrap items-center gap-[15px] p-[15px] ${
                  i < stories.length - 1 ? "border-b-2 border-dashed border-rule" : ""
                } ${story.status === "Declined" ? "bg-cream-2" : ""}`}
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
                    {storyRef(story.id)} · {story.filename}
                    {isAdmin ? ` · ${story.uploader.name}` : ""} ·{" "}
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
              </div>
            ))
          )}
        </div>

        <p className="m-0 mt-[13.2px] font-mono text-[11px] uppercase tracking-[0.05em] text-ink-3">
          Declined orders are listed here too — the rail only carries what is
          still moving.
        </p>
      </main>
    </>
  );
}
