import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

import { SourceLink } from "@/components/source-link";
import { sourceUrl } from "@/lib/runtime";

/*
 * Four faces, each with a job, which is how a real diner sign works: a script
 * logotype, fat slab for the shouting, a workhorse for the reading, and a
 * typewriter for anything that behaves like a docket.
 *
 * Loaded from ./fonts rather than `next/font/google`, which downloads them at
 * build time and so made every image build depend on fonts.googleapis.com
 * answering — CI's verify gate, the release build, and the README's own
 * build-from-source quick start. It failed that way once, and the error arrives
 * as a webpack stack trace about a font loader, which is nowhere near where
 * anyone looks. See ./fonts/README.md for the files and their licence.
 */

/** The logotype. Script logo over slab supporting type is period-correct. */
const script = localFont({
  src: "./fonts/pacifico-400.woff2",
  weight: "400",
  variable: "--font-script",
  display: "swap",
});

/** Headings. A Clarendon-ish fat slab — the "EAT" sign face. */
const slab = localFont({
  src: "./fonts/alfa-slab-one-400.woff2",
  weight: "400",
  variable: "--font-slab",
  display: "swap",
});

/**
 * Everything you actually read. Sturdy grotesque, holds up small.
 *
 * One variable file covers the 400/500/600/700 this app uses, which is why
 * there is a single woff2 here and a range rather than four weights.
 */
const archivo = localFont({
  src: "./fonts/archivo-100-900.woff2",
  weight: "100 900",
  variable: "--font-archivo",
  display: "swap",
});

/** Order tickets, refs, filenames, dimensions — anything typed on a docket. */
const courier = localFont({
  src: [
    { path: "./fonts/courier-prime-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/courier-prime-700.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-courier",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Pretty Please Print",
  description: "Invite-only 3D print requests for the office.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${script.variable} ${slab.variable} ${archivo.variable} ${courier.variable}`}
    >
      <body className="plate flex min-h-screen flex-col bg-cream text-ink antialiased">
        <div className="flex-1">{children}</div>
        {/* AGPL-3.0 section 13 wants the source offer in front of people using
            the app over a network. In the root layout it reaches every page,
            signed in or not, and is resolved server-side so a fork can point
            it at its own source with SOURCE_URL. */}
        <SourceLink href={sourceUrl()} />
      </body>
    </html>
  );
}
