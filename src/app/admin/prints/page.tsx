import Link from "next/link";

import { requireAdmin } from "@/lib/authz";
import { storyRef } from "@/lib/scope";
import { LIST_LIMIT_MAX, listPeopleWithPrints, listStories } from "@/lib/stories";
import { quantityText, relativeTime } from "@/lib/catalog";
import { AppHeader } from "@/components/app-header";
import { Kicker, PriorityChip, StatusChip } from "@/components/ui";
import { ColorSwatch } from "@/components/color-swatch";

export const dynamic = "force-dynamic";

/**
 * Prints by person — pick people, see everything they have uploaded.
 *
 * The owner's other views answer "what is waiting" (the queue), "where is
 * everything" (the rail) and "what finished" (history). None answers "what has
 * Ayla sent me", which is the question when somebody asks after their part,
 * when deciding whose turn it is, or before taking somebody off the list.
 *
 * Admin-only, and 404 rather than 403 for anybody else like the rest of
 * `/admin`. A client has no use for it — their own tickets are `/me` — and a
 * list of colleagues with a count beside each is exactly what `storyScope`
 * exists to keep from them.
 *
 * The selection lives in the query string (`?who=<id>&who=<id>`) and every
 * person is a link that adds or removes themselves from it. No form control,
 * no JavaScript: it can be bookmarked, and the guest list links straight to
 * one person's. The ids are filtered against the real roster before they are
 * used, and the list itself comes from `listStories`, so the scope rule is the
 * same one every other list goes through.
 */

type Search = { who?: string | string[]; before?: string };

/** `/admin/prints` with exactly these people selected. */
function hrefFor(ids: string[]): string {
  if (ids.length === 0) return "/admin/prints";
  return `/admin/prints?${ids.map((id) => `who=${encodeURIComponent(id)}`).join("&")}`;
}

export default async function PrintsByPersonPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const [params, admin] = await Promise.all([searchParams, requireAdmin()]);
  const people = await listPeopleWithPrints(admin);

  // Only ids that name somebody real, in roster order, each once. Whatever
  // else was typed into the URL is dropped rather than echoed or queried.
  const asked = new Set([params.who ?? []].flat());
  const selected = people.filter((p) => asked.has(p.id));
  const selectedIds = selected.map((p) => p.id);

  const before = Number(params.before);
  const { stories, nextCursor } = selected.length
    ? await listStories(admin, {
        uploaderIds: selectedIds,
        limit: LIST_LIMIT_MAX,
        before: Number.isInteger(before) && before > 0 ? before : undefined,
      })
    : { stories: [], nextCursor: null };

  const total = selected.reduce((sum, p) => sum + p.prints, 0);
  const names = selected.map((p) => p.name);
  const whose =
    names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

  return (
    <>
      <AppHeader user={admin} active="/admin/prints" />
      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <Kicker>Admin · who sent what</Kicker>
        <h1 className="m-0 mb-[13.2px] text-[46px] leading-[0.98] text-ink">Prints by person</h1>
        <p className="m-0 mb-[22px] max-w-[680px] text-[16.5px] leading-[1.5] text-ink-2 text-pretty">
          Pick one person or several to see everything they have uploaded, in any state —
          waiting, on the bed, finished or declined. Pick somebody again to take them out.
        </p>

        {/* ---- the people: each one a link that toggles itself ---- */}
        <nav aria-label="People" className="mb-[26.4px] flex flex-wrap items-center gap-[8.8px]">
          {people.map((p) => {
            const on = asked.has(p.id);
            const next = on ? selectedIds.filter((id) => id !== p.id) : [...selectedIds, p.id];
            return (
              <Link
                key={p.id}
                href={hrefFor(next)}
                aria-current={on ? "true" : undefined}
                className={`stamp inline-flex items-center gap-[8px] rounded-chip border-[3px] border-ink px-[13.2px] py-[6px] text-[14px] font-bold transition-colors ${
                  on ? "bg-cherry-dk text-cream" : "bg-porcelain text-ink hover:bg-sun"
                } ${p.suspended ? "opacity-70" : ""}`}
              >
                <span
                  aria-hidden
                  className="flex h-[24px] w-[24px] flex-none items-center justify-center rounded-full border-2 border-ink bg-aqua font-mono text-[10px] font-bold text-ink"
                >
                  {p.initials}
                </span>
                {p.name}
                <span className={`font-mono text-[12px] ${on ? "text-cream" : "text-ink-3"}`}>
                  {p.prints}
                </span>
                {p.isOwner && <span className="font-mono text-[10.5px] uppercase tracking-[0.06em]">you</span>}
                {p.suspended && (
                  <span className="font-mono text-[10.5px] uppercase tracking-[0.06em]">suspended</span>
                )}
              </Link>
            );
          })}
          {selected.length > 0 && (
            <Link
              href="/admin/prints"
              className="ml-[4px] font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-ink-2 underline decoration-2 underline-offset-4 hover:text-cherry-dk"
            >
              Clear
            </Link>
          )}
        </nav>

        {selected.length === 0 ? (
          <p className="m-0 max-w-[680px] rounded-panel border-[3px] border-dashed border-ink-3 bg-porcelain p-[22px] font-mono text-[12px] uppercase tracking-[0.06em] text-ink-3">
            Nobody picked yet. Choose somebody above.
          </p>
        ) : (
          <>
            <h2 className="m-0 mb-[13.2px] font-display text-[24px] text-ink">
              {total === 0
                ? `Nothing from ${whose} yet`
                : `${total} ${total === 1 ? "ticket" : "tickets"} from ${whose}`}
            </h2>
            <div className="overflow-hidden rounded-panel border-[3px] border-ink bg-porcelain shadow-stamp">
              {stories.length === 0 ? (
                <p className="m-0 p-[22px] font-mono text-[12px] uppercase tracking-[0.06em] text-ink-3">
                  {total === 0 ? "No uploads." : "Nothing older than that."}
                </p>
              ) : (
                stories.map((story, i) => (
                  <div
                    key={story.id}
                    className={`flex flex-wrap items-center gap-[15px] p-[15px] ${
                      i < stories.length - 1 ? "border-b-2 border-dashed border-rule" : ""
                    } ${story.status === "Declined" ? "bg-cream-2" : ""}`}
                  >
                    <ColorSwatch
                      mode={story.colorMode}
                      style={story.colorStyle ?? story.colorHex}
                      className="h-[40px] w-[40px] flex-none rounded-full border-[3px] border-ink"
                    />
                    <div className="min-w-[180px] flex-[1_1_240px]">
                      <Link
                        href={`/story/${story.id}`}
                        className="block break-words font-display text-[17px] leading-[1.2] text-ink hover:text-cherry-dk"
                      >
                        {story.title}
                      </Link>
                      <p className="m-0 mt-[3px] font-mono text-[11px] uppercase tracking-[0.04em] text-ink-3">
                        {storyRef(story.id)} · {story.uploader.name} · {quantityText(story.quantity)} ·{" "}
                        {story.material} · {relativeTime(story.createdAt)}
                      </p>
                    </div>
                    <PriorityChip priority={story.priority} quiet />
                    <StatusChip status={story.status} />
                  </div>
                ))
              )}
            </div>
            {nextCursor !== null && (
              <p className="m-0 mt-[17.6px]">
                <Link
                  href={`${hrefFor(selectedIds)}&before=${nextCursor}`}
                  className="stamp inline-block rounded-chip border-[3px] border-ink bg-aqua px-[17.6px] py-[8px] text-[14px] font-bold text-ink hover:bg-sun"
                >
                  Older tickets
                </Link>
              </p>
            )}
          </>
        )}
      </main>
    </>
  );
}
