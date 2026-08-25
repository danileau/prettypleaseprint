import type { ComponentProps, ReactNode } from "react";

/**
 * The neon logotype. A script wordmark on a lit disc — the sign over the door.
 *
 * `lit` runs the warm-up flicker once on load. Off by default so it fires on
 * the sign-in and claim screens only, where it is the first thing you see;
 * anywhere else it would be a tic.
 */
export function Brand({ size = 34, lit = false }: { size?: number; lit?: boolean }) {
  return (
    <span className="flex items-center gap-[13.2px]">
      <span
        aria-hidden
        className="relative flex flex-none items-center justify-center rounded-full border-[3px] border-ink bg-cherry"
        style={{ width: size, height: size }}
      >
        {/* The nozzle: a bead of filament coming off the tip. Reads as a
            cherry on a sundae at small sizes, which is the joke. */}
        <span
          className="rounded-full bg-cream"
          style={{ width: size * 0.26, height: size * 0.26 }}
        />
      </span>
      <span
        className={`font-script leading-none text-cherry-dk ${lit ? "ppp-neon" : ""}`}
        style={{ fontSize: size * 0.62 }}
      >
        pretty please print
      </span>
    </span>
  );
}

/** The little stamped label above a heading. */
export function Kicker({ children }: { children: ReactNode }) {
  return (
    <p className="mb-[8.8px] inline-block rounded-chip border-2 border-ink bg-sun px-[13.2px] py-[3px] font-mono text-[11.5px] font-bold uppercase tracking-[0.12em] text-ink">
      {children}
    </p>
  );
}

/**
 * The frame for every screen you reach before signing in. A menu board: dark
 * ground, one lit card, checkerboard along the bottom edge.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-[26.4px] py-[35.2px]">
      <div className="mb-[26.4px]">
        <Brand size={40} lit />
      </div>
      <div className="w-full max-w-[520px] overflow-hidden rounded-panel border-[3px] border-ink bg-porcelain shadow-stamp-lg">
        <div className="layers border-b-[3px] border-ink bg-aqua px-[26.4px] py-[13.2px]">
          <p className="m-0 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-ink">
            Open · come on in
          </p>
        </div>
        <div className="p-[35.2px]">{children}</div>
        <div className="checker h-[10px]" aria-hidden />
      </div>
    </main>
  );
}

export function H1({ children }: { children: ReactNode }) {
  return (
    <h1 className="m-0 mb-[13.2px] text-[34px] leading-[1.05] text-ink">
      {children}
    </h1>
  );
}

export function Lead({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 mb-[22px] text-[16.5px] leading-[1.55] text-ink-2 text-pretty">
      {children}
    </p>
  );
}

type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost";
};

/**
 * Enamel sign buttons: heavy keyline, hard offset shadow, and they sink onto
 * that shadow when pressed.
 *
 * Cherry-dark rather than plain cherry for the filled variant — white on
 * #E4322F is 4.0:1, which fails at button-label sizes. The darker fill clears
 * 6:1 and looks the same at a glance.
 */
export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonProps) {
  const base =
    "stamp cursor-pointer rounded-chip border-[3px] border-ink font-bold disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none";
  const skin = {
    primary: "bg-cherry-dk text-cream px-[28px] py-[13px] text-[16px] hover:bg-cherry",
    secondary: "bg-aqua text-ink px-[24px] py-[12px] text-[15px] hover:bg-aqua-wash",
    ghost:
      "bg-porcelain text-ink px-[20px] py-[11px] text-[15px] font-semibold hover:bg-cream-2",
  }[variant];
  return <button className={`${base} ${skin} ${className}`} {...props} />;
}

export function Label({
  htmlFor,
  children,
}: {
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-[6px] block font-mono text-[12px] font-bold uppercase tracking-[0.1em] text-ink-2"
    >
      {children}
    </label>
  );
}

export function Input({ className = "", ...props }: ComponentProps<"input">) {
  return (
    <input
      className={`w-full rounded-card border-[3px] border-ink bg-porcelain px-[15px] py-[12px] text-[16px] text-ink placeholder:text-ink-3 disabled:bg-cream-2 disabled:text-ink-2 ${className}`}
      {...props}
    />
  );
}

/**
 * An inline notice. Tone is carried by fill AND by a word, never by colour
 * alone — the heading text says which it is.
 */
export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "good";
  children: ReactNode;
}) {
  const skin = {
    info: { bg: "bg-cream-2", label: "Note" },
    warn: { bg: "bg-sun", label: "Hold on" },
    good: { bg: "bg-mint-wash", label: "Good" },
  }[tone];
  return (
    <div
      className={`rounded-card border-[3px] border-ink ${skin.bg} px-[17.6px] py-[13.2px] text-[15px] leading-[1.45] text-ink`}
    >
      <span className="mb-[2px] block font-mono text-[11px] font-bold uppercase tracking-[0.12em]">
        {skin.label}
      </span>
      {children}
    </div>
  );
}

/** A field on the order docket: typed label over its value. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-[4px] font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-ink-3">
        {label}
      </div>
      <div className="text-[16px] font-bold text-ink">{children}</div>
    </div>
  );
}

/**
 * Status chip. Bright fill, dark ink, heavy keyline — and the label is always
 * present, so the colour is reinforcement rather than the message.
 */
const CHIP_SKIN: Record<string, string> = {
  Requested: "bg-chrome text-ink",
  Accepted: "bg-aqua text-ink",
  Printing: "bg-sun text-ink",
  Delivery: "bg-cherry text-ink",
  Done: "bg-mint text-ink",
  Declined: "bg-cream-3 text-ink-2",
  // Feature-request states (see FEATURE_FLOW). Reuse the print palette's roles:
  // sun = in-progress/warning, cherry = wants-you-to-act.
  InProgress: "bg-sun text-ink",
  Shipped: "bg-cherry text-ink",
};

export function StatusChip({
  status,
  label,
  className = "",
}: {
  status: string;
  /** Display text when it differs from the enum value (e.g. "In progress"). */
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-block rounded-chip border-2 border-ink px-[11px] py-[3px] font-mono text-[11.5px] font-bold uppercase tracking-[0.08em] ${
        CHIP_SKIN[status] ?? CHIP_SKIN.Requested
      } ${className}`}
    >
      {label ?? status}
    </span>
  );
}
