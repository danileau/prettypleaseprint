"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { markAllRead, markRead } from "@/app/actions/notifications";

export type FeedItem = {
  id: string;
  text: string;
  when: string;
  read: boolean;
  storyId: number | null;
  featureId: number | null;
};

/**
 * The Activity panel. Handoff §1: 360px, radius 14, lg shadow, a 160ms
 * fade-and-rise, an 8px dot per row, and a count badge that fills teal only
 * when something is unread.
 */
export function ActivityMenu({
  items,
  unread,
  title,
}: {
  items: FeedItem[];
  unread: number;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        className="stamp flex cursor-pointer items-center gap-[8px] rounded-chip border-[3px] border-ink bg-cream px-[15px] py-[6px] font-mono text-[12px] font-bold uppercase tracking-[0.08em] text-ink hover:bg-sun"
      >
        Activity
        <span
          className={`inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-[6px] text-[12px] font-bold tabular-nums ${
            unread ? "bg-cherry-dk text-cream" : "bg-chrome text-ink-2"
          }`}
        >
          {unread}
        </span>
      </button>

      {open && (
        <div className="ppp-in absolute right-0 top-[50px] z-50 w-[360px] max-w-[84vw] rounded-panel border-[3px] border-ink bg-porcelain p-[17.6px] shadow-stamp-lg">
          <div className="mb-[8.8px] flex items-baseline justify-between gap-[13.2px]">
            <h2 className="m-0 font-display text-[17px]">
              {title}
            </h2>
            {unread > 0 && (
              <button
                type="button"
                disabled={pending}
                onClick={() => startTransition(() => void markAllRead())}
                className="cursor-pointer rounded-chip border-2 border-ink bg-cream-2 px-[10px] py-[2px] font-mono text-[11px] font-bold uppercase text-ink hover:bg-sun disabled:opacity-50"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="flex max-h-[330px] flex-col gap-[4.4px] overflow-auto">
            {items.length === 0 && (
              <p className="m-0 px-[4px] py-[11px] font-mono text-[12px] uppercase text-ink-3">
                Nothing yet.
              </p>
            )}
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  if (!item.read) startTransition(() => void markRead(item.id));
                  // Take them to whatever the notification is about. A feature
                  // request goes to /frr, a print to /story; a reference-less
                  // one (a withdrawal) just marks read.
                  const href =
                    item.featureId !== null
                      ? `/frr/${item.featureId}`
                      : item.storyId !== null
                        ? `/story/${item.storyId}`
                        : null;
                  if (href) window.location.assign(href);
                }}
                className={`flex cursor-pointer gap-[13.2px] rounded-card border-2 border-transparent px-[13.2px] py-[11px] text-left hover:border-ink hover:bg-cream-2 ${
                  item.read ? "bg-transparent" : "bg-sun-wash"
                }`}
              >
                <span
                  aria-hidden
                  className={`mt-[6px] h-[8px] w-[8px] flex-none rounded-full ${
                    item.read ? "bg-chrome" : "bg-cherry"
                  }`}
                />
                <span>
                  <span className="block text-[14px] leading-[1.35]">
                    {item.text}
                  </span>
                  <span className="mt-[2px] block font-mono text-[11px] text-ink-3">
                    {item.when}
                    {item.read ? "" : " · unread"}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
