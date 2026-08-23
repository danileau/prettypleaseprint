"use client";

import { useEffect, useState } from "react";

/**
 * Handoff: fixed, bottom-centre, near-black, 200ms fade and rise, gone after
 * 3.2 seconds. `role="status"` so a screen reader announces it without
 * stealing focus.
 */
export function Toast({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setVisible(false), 3200);
    return () => clearTimeout(t);
  }, []);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="ppp-toast fixed bottom-[30px] left-1/2 z-[60] max-w-[90vw] -translate-x-1/2 rounded-[10px] bg-near-black px-[26.4px] py-[14px] text-center text-[15px] font-semibold text-white shadow-lg"
    >
      {children}
    </div>
  );
}
