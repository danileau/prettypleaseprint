"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * The one prompt that gets people off emailed links.
 *
 * Accepting an invite offers a passkey once. Anyone who taps "not now" is on
 * an inbox round trip for every sign-in after that, forever, with nothing to
 * tell them there is a better way — which is the actual reason emailed links
 * feel like the whole experience.
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
    <div className="border-b border-border bg-teal-200">
      <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-[13.2px] px-[26.4px] py-[11px]">
        <p className="m-0 flex-1 text-[14.5px] leading-[1.4] text-teal-800">
          <strong className="font-semibold">
            Tired of waiting for the sign-in email?
          </strong>{" "}
          Save a passkey and this device signs you in with a fingerprint —
          no inbox, no link, no typing.
        </p>
        <Link
          href="/welcome"
          className="rounded-[8px] bg-teal px-[17.6px] py-[8.8px] text-[14px] font-bold text-teal-100 hover:bg-teal-600"
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
          className="rounded-[8px] px-[13.2px] py-[8.8px] text-[14px] font-semibold text-teal-700 hover:bg-teal-100"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
