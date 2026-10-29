import type { ColorMode } from "@/lib/catalog";

/**
 * A filament colour, drawn from a ticket's or a catalogue row's snapshot.
 *
 * `stripe` is the full-width band along the top of a card rather than a dot.
 * It is a prop and not a class the caller passes because the display mode is
 * the one thing this component has to own: it used to hard-code `inline-flex`
 * and take `block` through `className`, the two fought, and the band on every
 * card collapsed to the width of its content — nothing, or a clipped "?".
 *
 * `mark` draws the question mark on a "whatever" swatch. Callers turn it off
 * where the swatch is too small for a glyph to read as anything but dirt: the
 * 8px band and the 9px dot in a chip. The rainbow says it on its own there.
 */
export function ColorSwatch({
  mode,
  style,
  className = "",
  stripe = false,
  mark = true,
}: {
  mode: ColorMode;
  style: string;
  className?: string;
  stripe?: boolean;
  mark?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={`relative items-center justify-center overflow-hidden ${
        stripe ? "flex w-full" : "inline-flex"
      } ${className}`}
      style={{ background: style }}
    >
      {mode === "whatever" && mark && !stripe && (
        <span className="font-display text-[0.72em] leading-none text-cream [text-shadow:0_1px_2px_var(--color-shade),0_0_2px_var(--color-shade)]">
          ?
        </span>
      )}
    </span>
  );
}
