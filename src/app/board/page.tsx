import Link from "next/link";

import { db } from "@/lib/db";
import { requireUser, storyScope, printerName, FLOW } from "@/lib/authz";
import { AppHeader } from "@/components/app-header";
import { StoryCard, type CardStory } from "@/components/story-card";
import { Kicker } from "@/components/ui";
import { Toast } from "@/components/toast";

export const dynamic = "force-dynamic";

/**
 * The backlog board. Handoff §2.
 *
 * One column per status in flow order. `Declined` is deliberately absent: it
 * is a terminal branch off the flow, not a stage of it, and the board is for
 * work that is still moving. A declined story stays reachable from its own
 * URL and from the Activity panel, and will appear in the profile list when
 * that lands.
 */
export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const [{ sent }, user] = await Promise.all([searchParams, requireUser("/board")]);
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
        <div className="mb-[26.4px] flex flex-wrap items-end justify-between gap-[26.4px]">
          <div className="max-w-[620px]">
            <Kicker>
              {isAdmin
                ? "Admin view · every request, with who asked"
                : `Private to you and ${owner}`}
            </Kicker>
            <h1 className="m-0 mb-[13.2px] text-[42px] font-semibold leading-[1.05] tracking-[-0.02em]">
              The backlog
            </h1>
            <p className="m-0 text-[17px] leading-[1.5] text-muted-3 text-pretty">
              {isAdmin
                ? "Every story from the group, wherever it sits. Open one to see what was asked for."
                : `Every request is a story. Only you and ${owner} see yours — other people's requests stay theirs.`}
            </p>
          </div>
          <Link
            href="/upload"
            className="rounded-[8px] bg-teal px-[28px] py-[15px] text-[16px] font-bold text-teal-100 shadow-md hover:bg-teal-600 active:bg-teal-700"
          >
            Upload a model
          </Link>
        </div>

        {stories.length === 0 ? (
          <EmptyBoard isAdmin={isAdmin} />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(215px,1fr))] items-start gap-[17.6px]">
            {FLOW.map((status, i) => {
              const column = stories.filter((s) => s.status === status);
              return (
                <section
                  key={status}
                  className={`min-h-[180px] rounded-[14px] p-[17.6px] ${
                    i % 2 === 0 ? "bg-surface" : "bg-surface-2"
                  }`}
                >
                  <div className="mb-[13.2px] flex items-center justify-between">
                    <h2
                      className={`m-0 text-[14px] font-extrabold uppercase tracking-[0.04em] ${
                        // Amber is the in-progress colour per the design tokens.
                        status === "Printing" ? "text-amber-text" : "text-muted-3"
                      }`}
                    >
                      {status}
                    </h2>
                    <span className="text-[13px] font-bold tabular-nums text-muted">
                      {column.length}
                    </span>
                  </div>

                  <div className="flex flex-col gap-[11px]">
                    {column.length === 0 ? (
                      <p className="m-0 px-[4px] py-[11px] text-[13px] text-muted">
                        Nothing here.
                      </p>
                    ) : (
                      column.map((story) => (
                        <StoryCard
                          key={story.id}
                          story={story}
                          showUploader={isAdmin}
                        />
                      ))
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        )}

      </main>

      {sent && <Toast>Sent · {owner} has been notified</Toast>}
    </>
  );
}

/**
 * The handoff explicitly does not design this state and says to ask before
 * inventing one. This is the minimum that avoids a blank page: it says what
 * is true and offers the one action available. Replace it once the real
 * empty state is designed.
 */
function EmptyBoard({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="rounded-[14px] bg-surface p-[35.2px] text-center">
      <p className="m-0 text-[17px] font-semibold">
        {isAdmin ? "Nobody has sent you anything yet." : "No requests yet."}
      </p>
      <p className="m-0 mx-auto mt-[8.8px] max-w-[46ch] text-[15px] text-muted">
        {isAdmin
          ? "When someone in the group uploads a model it lands here, and you get a notification."
          : "Drop an .stl or .3mf and it turns up here as a story you can follow."}
      </p>
    </div>
  );
}
