"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { markAllRead, markRead } from "@/app/actions/notifications";

export type FeedItem = {
  id: string;
  text: string;
  when: string;
  read: boolean;
  storyId: number | null;
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
        className="flex items-center gap-[8.8px] rounded-[8px] border border-border bg-card px-[17.6px] py-[8.8px] text-[14px] font-semibold hover:bg-teal-200"
      >
        Activity
        <span
          className={`inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-[6px] text-[12px] font-bold tabular-nums ${
            unread ? "bg-teal text-teal-100" : "bg-line text-muted-2"
          }`}
        >
          {unread}
        </span>
      </button>

      {open && (
        <div className="ppp-in absolute right-0 top-[46px] z-50 w-[360px] max-w-[84vw] rounded-[14px] border border-border bg-card p-[17.6px] shadow-lg">
          <div className="mb-[8.8px] flex items-baseline justify-between gap-[13.2px]">
            <h2 className="m-0 text-[17px] font-semibold tracking-[-0.012em]">
              {title}
            </h2>
            {unread > 0 && (
              <button
                type="button"
                disabled={pending}
                onClick={() => startTransition(() => void markAllRead())}
                className="rounded-full px-[8.8px] py-[4.4px] text-[13px] font-semibold text-teal-700 hover:bg-teal-200 disabled:opacity-50"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="flex max-h-[330px] flex-col gap-[4.4px] overflow-auto">
            {items.length === 0 && (
              <p className="m-0 px-[4px] py-[11px] text-[13px] text-muted">
                Nothing yet.
              </p>
            )}
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  if (!item.read) startTransition(() => void markRead(item.id));
                }}
                className={`flex gap-[13.2px] rounded-[10px] px-[13.2px] py-[11px] text-left hover:bg-surface-2 ${
                  item.read ? "bg-transparent" : "bg-teal-100"
                }`}
              >
                <span
                  aria-hidden
                  className={`mt-[6px] h-[8px] w-[8px] flex-none rounded-full ${
                    item.read ? "bg-line-2" : "bg-teal"
                  }`}
                />
                <span>
                  <span className="block text-[14px] leading-[1.35]">
                    {item.text}
                  </span>
                  <span className="mt-[2px] block text-[12px] text-muted">
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
