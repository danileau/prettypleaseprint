import type { ComponentProps, ReactNode } from "react";

/** 34px teal circle + wordmark. Handoff §1, renamed. */
export function Brand({ size = 34 }: { size?: number }) {
  return (
    <div className="flex items-center gap-[13.2px]">
      <span
        aria-hidden
        className="block rounded-full bg-teal shadow-md"
        style={{ width: size, height: size }}
      />
      <span
        className="font-semibold tracking-[-0.01em]"
        style={{ fontSize: size * 0.55 }}
      >
        pretty please print
      </span>
    </div>
  );
}

/** Uppercase mono kicker. Handoff type scale. */
export function Kicker({ children }: { children: ReactNode }) {
  return (
    <p className="mb-[8.8px] font-mono text-[13px] font-bold uppercase tracking-[0.08em] text-teal-700">
      {children}
    </p>
  );
}

/**
 * Centred single-column frame used by every unauthenticated screen:
 * sign-in, invite claim, and the errors either can end at.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[520px] flex-col justify-center px-[26.4px] py-[35.2px]">
      <div className="mb-[26.4px]">
        <Brand size={30} />
      </div>
      <div className="rounded-[14px] bg-card p-[35.2px] shadow-sm">{children}</div>
    </main>
  );
}

export function H1({ children }: { children: ReactNode }) {
  return (
    <h1 className="m-0 mb-[13.2px] text-[32px] font-semibold leading-[1.1] tracking-[-0.02em]">
      {children}
    </h1>
  );
}

export function Lead({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 mb-[22px] text-[16px] leading-[1.5] text-muted-3 text-pretty">
      {children}
    </p>
  );
}

type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost";
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonProps) {
  const base =
    "rounded-[8px] text-[16px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-55";
  const skin = {
    primary:
      "bg-teal text-teal-100 px-[28px] py-[15px] shadow-md hover:bg-teal-600 active:bg-teal-700",
    secondary:
      "bg-slate text-slate-100 px-[24px] py-[13.2px] text-[15px] hover:bg-slate-600",
    ghost:
      "bg-transparent text-muted-2 px-[20px] py-[13.2px] text-[15px] font-semibold hover:bg-surface-2",
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
      className="mb-[6px] block text-[13.5px] font-bold text-ink"
    >
      {children}
    </label>
  );
}

export function Input({ className = "", ...props }: ComponentProps<"input">) {
  return (
    <input
      className={`w-full rounded-[8px] border border-border bg-card px-[17.6px] py-[13.2px] text-[15px] text-ink placeholder:text-line-3 ${className}`}
      {...props}
    />
  );
}

/**
 * Inline message block. `tone` never carries meaning on its own — each
 * variant renders its own text, so colour is never the only signal.
 */
export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "good";
  children: ReactNode;
}) {
  const skin = {
    info: "bg-surface-2 text-muted-3",
    warn: "bg-amber-fill text-amber-text",
    good: "bg-teal-200 text-teal-700",
  }[tone];
  return (
    <div
      className={`rounded-[10px] px-[17.6px] py-[13.2px] text-[14.5px] leading-[1.45] ${skin}`}
    >
      {children}
    </div>
  );
}

/** Mono uppercase micro-label over a value. Handoff wish-card pattern. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-[5px] font-mono text-[12px] font-bold uppercase tracking-[0.06em] text-muted">
        {label}
      </div>
      <div className="text-[15.5px] font-bold">{children}</div>
    </div>
  );
}
