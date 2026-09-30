import type { ColorMode } from "@/lib/catalog";

export function ColorSwatch({
  mode,
  style,
  className = "",
}: {
  mode: ColorMode;
  style: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={`relative inline-flex items-center justify-center overflow-hidden ${className}`}
      style={{ background: style }}
    >
      {mode === "whatever" && (
        <span className="font-display text-[0.72em] leading-none text-cream [text-shadow:0_1px_2px_#1b2126,0_0_2px_#1b2126]">
          ?
        </span>
      )}
    </span>
  );
}
