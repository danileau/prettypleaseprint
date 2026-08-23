"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * The one prompt that gets people onto passkeys.
 *
 * Registration offers a passkey once. Anyone who taps "not now" types a
 * password for every sign-in after that, forever, with nothing to tell them
 * there is a better way — which is the actual reason passwords feel like the
 * whole experience.
 *
 * So it asks again. Dismissible, but only for the session: closing it is "not
 * right now", not "never mention this again". It disappears for good the
 * moment a passkey exists, which is the only end state worth having.
 */
const DISMISSED_KEY = "ppp.passkey-nudge-dismissed";

export function PasskeyNudge() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    // Rendering server-side would flash the banner before we know whether
    // this browser can even do WebAuthn.
    if (typeof window === "undefined" || !window.PublicKeyCredential) return;
    try {
      if (sessionStorage.getItem(DISMISSED_KEY) === "1") return;
    } catch {
      // Private mode or blocked storage — showing it is the safe default.
    }
    setShow(true);
  }, []);

  if (!show) return null;

  return (
    <div className="border-b-[3px] border-ink bg-aqua-wash">
      <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-[13.2px] px-[26.4px] py-[11px]">
        <p className="m-0 flex-1 text-[14.5px] leading-[1.4] text-ink">
          <strong className="font-display text-[15px]">
            Tired of typing your password?
          </strong>{" "}
          Save a passkey and this device signs you in with a fingerprint —
          nothing to remember, nothing to phish.
        </p>
        <Link
          href="/welcome"
          className="stamp cursor-pointer rounded-chip border-[3px] border-ink bg-cherry-dk px-[17.6px] py-[7px] text-[13.5px] font-bold text-cream hover:bg-cherry"
        >
          Set it up — 30 seconds
        </Link>
        <button
          type="button"
          onClick={() => {
            try {
              sessionStorage.setItem(DISMISSED_KEY, "1");
            } catch {
              /* dismissal just will not stick; the banner is not worth an error */
            }
            setShow(false);
          }}
          className="cursor-pointer rounded-chip border-2 border-transparent px-[13.2px] py-[7px] text-[13.5px] font-bold text-ink-2 hover:border-ink hover:bg-porcelain"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
