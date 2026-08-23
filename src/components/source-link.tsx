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
  return (
    <footer className="mx-auto w-full max-w-[1180px] px-[26.4px] pb-[26.4px] pt-[8.8px]">
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3 underline underline-offset-2 hover:text-cherry-dk"
      >
        Source · AGPL-3.0
      </a>
    </footer>
  );
}
