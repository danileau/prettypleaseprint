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
        className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-slate-300 text-[12.5px] font-extrabold text-slate-800 hover:bg-slate-400"
      >
        {initials}
      </button>

      {open && (
        <div className="ppp-in absolute right-0 top-[44px] z-50 w-[260px] rounded-[14px] border border-border bg-card p-[17.6px] shadow-lg">
          <p className="m-0 text-[15px] font-bold">{name}</p>
          <p className="m-0 mt-[2px] text-[13px] text-muted">{email}</p>
          <p className="m-0 mt-[8.8px] font-mono text-[11.5px] font-bold uppercase tracking-[0.06em] text-muted">
            {role === "admin" ? "Printer owner" : "Invited member"}
          </p>
          {/* How you sign in, and a way to change it. Without this the only
              passkey prompt in the whole app is the one at invite time. */}
          <div className="mt-[13.2px] border-t border-rule pt-[13.2px]">
            <p className="m-0 text-[13px] text-muted">
              {passkeyCount === 0
                ? "Signing in by emailed link"
                : `${passkeyCount} passkey${passkeyCount === 1 ? "" : "s"} on this account`}
            </p>
            <a
              href="/welcome"
              className="mt-[6px] inline-block text-[14px] font-semibold text-teal-700 hover:text-teal-600"
            >
              {passkeyCount === 0 ? "Add a passkey →" : "Add another →"}
            </a>
          </div>

          <button
            type="button"
            onClick={async () => {
              await authClient.signOut();
              window.location.assign("/signin");
            }}
            className="mt-[13.2px] w-full rounded-[8px] border border-border bg-transparent px-[17.6px] py-[10px] text-[14px] font-semibold hover:bg-surface-2"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
