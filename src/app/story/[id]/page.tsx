import Link from "next/link";
import { notFound } from "next/navigation";

import { getStoryOr404, printerName, requireUser, storyRef, FLOW } from "@/lib/authz";
import { STATUS_CHIP, quantityText, relativeTime } from "@/lib/catalog";
import { formatBytes } from "@/lib/models";
import { AppHeader } from "@/components/app-header";
import { Fact } from "@/components/ui";
import { Toast } from "@/components/toast";

export const dynamic = "force-dynamic";

/**
 * Story detail — the read half. Handoff §4.
 *
 * The 3D viewer, the conversation and the admin action panel are the next
 * slice. What is here is everything that does not need them: the file's
 * measured meta, the wish, and where the story sits in the flow.
 */
export default async function StoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ sent?: string }>;
}) {
  const [{ id }, { sent }] = await Promise.all([params, searchParams]);
  const storyId = Number(id);
  if (!Number.isInteger(storyId)) notFound();

  const user = await requireUser(`/story/${id}`);
  // 404s rather than 403s for a client asking after someone else's story —
  // a 403 would confirm it exists.
  const story = await getStoryOr404(storyId, user);
  const owner = await printerName();

  const chip = STATUS_CHIP[story.status] ?? STATUS_CHIP.Requested!;
  const currentIndex = (FLOW as readonly string[]).indexOf(story.status);

  return (
    <>
      <AppHeader user={user} active="/board" />

      <main className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <Link
          href="/board"
          className="inline-block py-[6px] pr-[13.2px] text-[14px] font-semibold text-muted-2 hover:text-teal-700"
        >
          ← Back to the backlog
        </Link>

        <div className="mt-[13.2px] grid grid-cols-[repeat(auto-fit,minmax(330px,1fr))] items-start gap-[26.4px]">
          {/* ---------- left: the file ---------- */}
          <div>
            <div className="flex h-[380px] flex-col items-center justify-center rounded-[14px] bg-surface p-[26.4px] text-center shadow-md">
              <span
                aria-hidden
                className="mb-[17.6px] h-[64px] w-[64px] rounded-[10px]"
                style={{
                  background: story.colorHex,
                  boxShadow: "inset 0 0 0 1px rgba(20,24,28,0.2)",
                }}
              />
              <p className="m-0 text-[15px] font-bold">{story.filename}</p>
              <p className="m-0 mt-[8.8px] max-w-[36ch] text-[13.5px] text-muted">
                The rotatable 3D view is the next piece of work. The geometry
                below was measured from this file on upload.
              </p>
            </div>

            {/* Both measured from the file itself. Nothing inferred. */}
            <div className="mt-[13.2px] flex flex-wrap gap-[17.6px] text-[13.5px] text-muted-2">
              <span>{story.dims ?? "dimensions unknown"}</span>
              <span>{formatBytes(story.fileSize)}</span>
            </div>
          </div>

          {/* ---------- right: the wish and the flow ---------- */}
          <div>
            <div className="mb-[8.8px] flex flex-wrap items-center gap-[8.8px]">
              <span className="font-mono text-[12px] font-bold tracking-[0.06em] text-muted">
                {storyRef(story.id)}
              </span>
              <span
                className="rounded-full px-[12px] py-[4px] text-[12.5px] font-bold"
                style={{ background: chip.bg, color: chip.fg }}
              >
                {story.status}
              </span>
              {story.flagged && (
                <span className="rounded-full bg-amber-fill px-[12px] py-[4px] text-[12.5px] font-bold text-amber-text">
                  flagged{story.flagReason ? `: ${story.flagReason}` : ""}
                </span>
              )}
            </div>

            <h1 className="m-0 mb-[13.2px] text-[32px] font-semibold leading-[1.1] tracking-[-0.02em]">
              {story.title}
            </h1>
            {story.note && (
              <p className="m-0 mb-[22px] text-[16px] leading-[1.5] text-muted-3 text-pretty">
                {story.note}
              </p>
            )}

            <div className="rounded-[14px] bg-card p-[22px] shadow-sm">
              <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-[17.6px]">
                <Fact label="Asked by">{story.uploader.name}</Fact>
                <Fact label="Quantity">{quantityText(story.quantity)}</Fact>
                <Fact label="Material">{story.material}</Fact>
                <Fact label="Colour wish">
                  <span className="flex items-center gap-[8.8px]">
                    <span
                      aria-hidden
                      className="h-[18px] w-[18px] rounded-full"
                      style={{
                        background: story.colorHex,
                        boxShadow: "inset 0 0 0 1px rgba(20,24,28,0.2)",
                      }}
                    />
                    {story.colorName}
                  </span>
                </Fact>
                <Fact label="On offer">
                  <span className="text-slate-700">{story.tip}</span>
                </Fact>
              </div>
            </div>

            <section className="mt-[26.4px]">
              <h2 className="m-0 mb-[13.2px] text-[20px] font-semibold tracking-[-0.012em]">
                Progress
              </h2>
              {story.status === "Declined" ? (
                <p className="m-0 rounded-[10px] bg-surface-2 px-[17.6px] py-[13.2px] text-[15px] text-muted-2">
                  This one was declined {relativeTime(story.updatedAt)}.
                </p>
              ) : (
                <ol className="m-0 flex list-none flex-col p-0">
                  {FLOW.map((step, i) => {
                    const done = currentIndex >= 0 && i < currentIndex;
                    const now = i === currentIndex;
                    return (
                      <li key={step} className="flex items-start gap-[13.2px]">
                        <div className="flex flex-none flex-col items-center">
                          <span
                            aria-hidden
                            className="h-[18px] w-[18px] rounded-full"
                            style={{
                              background: done
                                ? "#4a5d78"
                                : now
                                  ? "#12645f"
                                  : "#d7dbdf",
                              boxShadow: now ? "0 0 0 5px #d9ebe9" : "none",
                            }}
                          />
                          {i < FLOW.length - 1 && (
                            <span
                              aria-hidden
                              className="w-[2px] flex-1"
                              style={{
                                minHeight: "26px",
                                background: done ? "#93a3b8" : "#d7dbdf",
                              }}
                            />
                          )}
                        </div>
                        <div className="pb-[17.6px]">
                          <div
                            className={`text-[15.5px] font-bold ${
                              done || now ? "text-ink" : "text-muted"
                            }`}
                          >
                            {step}
                          </div>
                          <div className="mt-[2px] text-[13px] text-muted">
                            {now ? "now" : done ? "cleared" : "waiting"}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          </div>
        </div>
      </main>

      {sent && <Toast>Sent · {owner} has been notified</Toast>}
    </>
  );
}
