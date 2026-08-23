/**
 * The fixed choices a request can be made from, exactly as the handoff lists
 * them. The form renders from these and the server validates against them, so
 * the two cannot drift apart.
 */
import { z } from "zod";

export const MATERIALS = ["PLA", "PETG", "TPU", "Resin"] as const;
export const DEFAULT_MATERIAL = "PETG";

/** Filament swatches. Light ones need the inset ring to stay visible. */
export const COLORS = [
  { name: "Teal", hex: "#12645f" },
  { name: "Slate", hex: "#4a5d78" },
  { name: "Bone white", hex: "#eaecee" },
  { name: "Graphite", hex: "#1b2126" },
  { name: "Whatever's on", hex: "#b6bcc2" },
] as const;
export const DEFAULT_COLOR = COLORS[1]; // Slate

export const TIPS = [
  "A beer",
  "A coffee",
  "A spool of filament",
  "Nerd stuff",
  "Nothing, sorry",
] as const;
export const DEFAULT_TIP = TIPS[0];

/** Shortcut quantities. A typed number is accepted too — see `QuantitySchema`. */
export const QUANTITY_PRESETS = [1, 2, 3, 4, 6] as const;

export const STATUS_CHIP: Record<
  string,
  { bg: string; fg: string }
> = {
  Requested: { bg: "#eaecee", fg: "#4d565e" },
  Accepted: { bg: "#dde3ec", fg: "#2c3a4d" },
  Printing: { bg: "#f7ecd4", fg: "#79541a" },
  Done: { bg: "#d9ebe9", fg: "#0b4340" },
  Delivery: { bg: "#e2e6ea", fg: "#1b2126" },
  Declined: { bg: "#e2e6ea", fg: "#6b747c" },
};

const colorNames = COLORS.map((c) => c.name) as unknown as [string, ...string[]];

export const QuantitySchema = z.coerce
  .number()
  .int("Whole prints only.")
  .min(1, "At least one.")
  // Validated server-side, so the message cannot name the admin (this module
  // is shared with the client bundle). The upload form says who to ask.
  .max(24, "More than 24 is a production run — ask the printer owner first.");

export const WishSchema = z.object({
  title: z
    .string()
    .trim()
    .max(120, "Keep the title under 120 characters.")
    .optional()
    .default(""),
  material: z.enum(MATERIALS),
  colorName: z.enum(colorNames),
  quantity: QuantitySchema,
  tip: z.enum(TIPS),
  note: z.string().trim().max(2000, "That note is very long.").optional().default(""),
});

export type Wish = z.infer<typeof WishSchema>;

export function hexForColor(name: string): string {
  return COLORS.find((c) => c.name === name)?.hex ?? DEFAULT_COLOR.hex;
}

/** "4 prints" / "1 print" */
export const quantityText = (n: number) => `${n} ${n === 1 ? "print" : "prints"}`;

/** Relative time, the way every card in the handoff shows it. */
export function relativeTime(date: Date): string {
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  if (abs < 45_000) return "just now";
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [86_400_000 * 365, "year"],
    [86_400_000 * 30, "month"],
    [86_400_000 * 7, "week"],
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  const fmt = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [ms, unit] of units) {
    if (abs >= ms) return fmt.format(Math.round(diff / ms), unit);
  }
  return "just now";
}
