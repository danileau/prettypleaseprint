import type { Metadata } from "next";
import { Alfa_Slab_One, Archivo, Courier_Prime, Pacifico } from "next/font/google";
import "./globals.css";

import { SourceLink } from "@/components/source-link";
import { sourceUrl } from "@/lib/runtime";

/*
 * Four faces, each with a job, which is how a real diner sign works: a script
 * logotype, fat slab for the shouting, a workhorse for the reading, and a
 * typewriter for anything that behaves like a docket.
 */

/** The logotype. Script logo over slab supporting type is period-correct. */
const script = Pacifico({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-script",
  display: "swap",
});

/** Headings. A Clarendon-ish fat slab — the "EAT" sign face. */
const slab = Alfa_Slab_One({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-slab",
  display: "swap",
});

/** Everything you actually read. Sturdy grotesque, holds up small. */
const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-archivo",
  display: "swap",
});

/** Order tickets, refs, filenames, dimensions — anything typed on a docket. */
const courier = Courier_Prime({
  subsets: ["latin"],
  weight: ["400", "700"],
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
