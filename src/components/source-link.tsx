import Link from "next/link";

/**
 * Where the source of *this* instance lives.
 *
 * The app is AGPL-3.0, whose section 13 says anyone who modifies it and lets
 * people use their version over a network must offer those users the
 * corresponding source. Nobody honours that from a link in a README they will
 * never open, so it belongs in the running app, on every page.
 *
 * Deliberately takes the URL rather than reading it: this renders inside the
 * root layout, and a component that reached for `process.env` would also be
 * dragged into the client bundle by anything that imports it, where the value
 * is simply absent.
 */
export function SourceLink({ href }: { href: string }) {
  const link =
    "font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 underline underline-offset-2 hover:text-cherry-dk";
  return (
    <footer className="mx-auto flex w-full max-w-[1180px] flex-wrap gap-x-[17.6px] gap-y-[4px] px-[26.4px] pb-[26.4px] pt-[8.8px]">
      <a href={href} target="_blank" rel="noreferrer noopener" className={link}>
        Source · AGPL-3.0
      </a>
      {/* Who made it. A plain same-origin link, so it needs no client code;
          signed-out visitors who follow it land on sign-in like anywhere else. */}
      <Link href="/about" className={link}>
        About · credits
      </Link>
    </footer>
  );
}
