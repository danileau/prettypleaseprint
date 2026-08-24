"use client";

import { useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";

/**
 * Replaces the prototype's role switcher, which the handoff marks as
 * "prototype only, drop it in production". Roles come from the session now,
 * so there is nothing to switch — this is the signed-in user and a way out.
 */
export function UserMenu({
  name,
  initials,
  email,
  role,
  passkeyCount,
}: {
  name: string;
  initials: string;
  email: string;
  role: "client" | "admin";
  passkeyCount: number;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
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
        aria-label={`Account menu for ${name}`}
        className="stamp flex h-[36px] w-[36px] cursor-pointer items-center justify-center rounded-full border-[3px] border-ink bg-aqua font-mono text-[12px] font-bold text-ink hover:bg-sun"
      >
        {initials}
      </button>

      {open && (
        <div className="ppp-in absolute right-0 top-[50px] z-50 w-[264px] rounded-panel border-[3px] border-ink bg-porcelain p-[17.6px] shadow-stamp-lg">
          <p className="m-0 font-display text-[17px] text-ink">{name}</p>
          <p className="m-0 mt-[2px] font-mono text-[11.5px] text-ink-3">{email}</p>
          <p className="m-0 mt-[8.8px] inline-block rounded-chip border-2 border-ink bg-cream-2 px-[8px] font-mono text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink">
            {role === "admin" ? "Printer owner" : "Invited member"}
          </p>
          {/* How you sign in, and a way to change it. Without this the only
              passkey prompt in the whole app is the one at invite time. */}
          <div className="mt-[13.2px] border-t-2 border-dashed border-rule pt-[13.2px]">
            <p className="m-0 font-mono text-[11.5px] uppercase text-ink-3">
              {passkeyCount === 0
                ? "Signing in with a password"
                : `${passkeyCount} passkey${passkeyCount === 1 ? "" : "s"} on this account`}
            </p>
            <a
              href="/welcome"
              className="mt-[6px] inline-block font-bold text-[14px] text-cherry-dk underline underline-offset-2 hover:text-cherry"
            >
              {passkeyCount === 0 ? "Add a passkey →" : "Add another →"}
            </a>
          </div>

          {/* The API console. In the account menu rather than the nav because
              it is a tool for the person, not a place the work lives — and
              because somebody who wants it goes looking here first. Not
              admin-only: a client's own tickets are as reachable over HTTP as
              they are on the board, under exactly the same scope. */}
          <div className="mt-[13.2px] border-t-2 border-dashed border-rule pt-[13.2px]">
            <a
              href="/docs"
              className="font-bold text-[14px] text-cherry-dk underline underline-offset-2 hover:text-cherry"
            >
              API &amp; docs →
            </a>
            <p className="m-0 mt-[2px] font-mono text-[11.5px] text-ink-3">
              Every endpoint, and a console to call them from.
            </p>
          </div>

          <button
            type="button"
            onClick={async () => {
              await authClient.signOut();
              window.location.assign("/signin");
            }}
            className="stamp mt-[13.2px] w-full cursor-pointer rounded-chip border-[3px] border-ink bg-cream-2 px-[17.6px] py-[9px] text-[14px] font-bold text-ink hover:bg-cherry-wash"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
