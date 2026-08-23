import Link from "next/link";

import { db } from "@/lib/db";
import { requireUser, storyScope, printerName, BOARD } from "@/lib/authz";
import { AppHeader } from "@/components/app-header";
import { StoryCard, type CardStory } from "@/components/story-card";
import { Kicker } from "@/components/ui";
import { Toast } from "@/components/toast";

export const dynamic = "force-dynamic";

/**
 * The backlog, as the short-order rail.
 *
 * One rail per stage in flow order. `Declined` is deliberately absent: it is a
 * terminal branch off the flow, not a stage of it, and the rail is for work
 * that is still moving. A declined story stays reachable from its own URL and
 * from the Activity panel.
 *
 * Each rail gets its own colour on the header bar so the room reads at a
 * glance — but the stage name is always written out, so nobody has to know
 * the colour code.
 */
const RAIL: Record<string, { bar: string; note: string }> = {
  Requested: { bar: "bg-chrome", note: "waiting on a yes" },
  Accepted: { bar: "bg-aqua", note: "queued up" },
  Printing: { bar: "bg-sun", note: "on the bed" },
  Delivery: { bar: "bg-cherry", note: "come and get it" },
  // Not a rail — Done is where a ticket leaves the board. Kept in the map so
  // a chip rendered off-board still finds its colour. The colours did not move
  // with the order because they were never about position: cherry is the
  // state that wants somebody to act, mint is the settled one.
  Done: { bar: "bg-mint", note: "handed over" },
};

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; toast?: string }>;
}) {
  const [{ sent, toast }, user] = await Promise.all([searchParams, requireUser("/board")]);
  const owner = await printerName();

  // The authorisation rule, composed into the query rather than filtered
  // afterwards: a client's own stories never leave the database.
  const stories = (await db.story.findMany({
    where: storyScope(user),
    orderBy: { createdAt: "desc" },
    include: { uploader: { select: { name: true, initials: true } } },
  })) as CardStory[];

  const isAdmin = user.role === "admin";

  return (
    <>
      <AppHeader user={user} active="/board" />

      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        {/* The menu board. */}
        <div className="starburst mb-[26.4px] overflow-hidden rounded-panel border-[3px] border-ink bg-cream-2 shadow-stamp-lg">
          <div className="flex flex-wrap items-end justify-between gap-[22px] p-[26.4px]">
            <div className="max-w-[620px]">
              <Kicker>
                {isAdmin ? "Admin view · every ticket, with who asked" : `Private to you and ${owner}`}
              </Kicker>
              <h1 className="m-0 mb-[11px] text-[46px] leading-[0.95] text-ink">
                The backlog
              </h1>
              <p className="m-0 text-[16.5px] leading-[1.5] text-ink-2 text-pretty">
                {isAdmin
                  ? "Every ticket from the group, wherever it sits on the rail. Open one to see what was asked for."
                  : `Every request is a ticket on the rail. Only you and ${owner} see yours — other people's stay theirs.`}
              </p>
            </div>
            <Link
              href="/upload"
              className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-cherry-dk px-[28px] py-[14px] font-display text-[18px] text-cream hover:bg-cherry"
            >
              Order a print
            </Link>
          </div>
          <div className="checker h-[10px] border-t-[3px] border-ink" aria-hidden />
        </div>

        {stories.length === 0 ? (
          <EmptyBoard isAdmin={isAdmin} owner={owner} />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] items-start gap-[13.2px]">
            {BOARD.map((status) => {
              const column = stories.filter((s) => s.status === status);
              const rail = RAIL[status]!;
              return (
                <section
                  key={status}
                  className="overflow-hidden rounded-panel border-[3px] border-ink bg-cream-2"
                  style={{ ["--tear-color" as string]: "#f6e7ce" }}
                >
                  <div
                    className={`layers flex items-center justify-between border-b-[3px] border-ink ${rail.bar} px-[13.2px] py-[8px]`}
                  >
                    <h2 className="m-0 font-mono text-[12.5px] font-bold uppercase tracking-[0.1em] text-ink">
                      {status}
                    </h2>
                    <span className="rounded-chip border-2 border-ink bg-porcelain px-[7px] font-mono text-[11.5px] font-bold tabular-nums text-ink">
                      {column.length}
                    </span>
                  </div>

                  <div className="flex min-h-[150px] flex-col gap-[13.2px] p-[13.2px]">
                    {column.length === 0 ? (
                      <p className="m-0 px-[4px] py-[8px] font-mono text-[11.5px] uppercase tracking-[0.06em] text-ink-3">
                        {rail.note} — nothing here
                      </p>
                    ) : (
                      column.map((story) => (
                        <StoryCard key={story.id} story={story} showUploader={isAdmin} />
                      ))
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        )}

        <p className="m-0 mt-[17.6px] font-mono text-[11px] uppercase tracking-[0.05em] text-ink-3">
          The rail carries what is still moving.{" "}
          <Link href="/me" className="underline underline-offset-2 hover:text-cherry-dk">
            {isAdmin ? "The books" : "My orders"}
          </Link>{" "}
          has everything, declined included.
        </p>
      </main>

      {sent && <Toast>Order in · {owner} has been notified</Toast>}
      {/* Anything else an action wants to report — a withdrawal, say. `sent`
          stays as its own flag because its wording depends on who owns the
          printer, which an action would have to look up to say. */}
      {!sent && toast && <Toast>{toast}</Toast>}
    </>
  );
}

/**
 * The handoff does not design this state and says to ask before inventing one.
 * This stays minimal on purpose: it says what is true and points at the one
 * action available.
 */
function EmptyBoard({ isAdmin, owner }: { isAdmin: boolean; owner: string }) {
  return (
    <div className="rounded-panel border-[3px] border-dashed border-ink-3 bg-cream-2 px-[26.4px] py-[44px] text-center">
      <p className="m-0 font-display text-[24px] text-ink">
        {isAdmin ? "Nobody has ordered anything yet." : "No requests yet."}
      </p>
      <p className="m-0 mx-auto mt-[11px] max-w-[46ch] text-[15.5px] leading-[1.5] text-ink-2">
        {isAdmin
          ? "When someone in the group sends a model it lands on the rail, and you get a notification."
          : `Drop an .stl or .3mf and it turns up here as a ticket ${owner} can work through.`}
      </p>
    </div>
  );
}
