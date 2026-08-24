import { storyRef } from "@/lib/scope";

/**
 * "Open in PrusaSlicer" — a link to the `ppp://` scheme a helper on the
 * viewer's own machine handles.
 *
 * Why a bare `<a>` to a custom scheme rather than a download, a signed URL, or
 * PrusaSlicer's own `prusaslicer://open?file=` deep link:
 *
 *   - `prusaslicer://` only downloads from a hardcoded allowlist
 *     (printables.com, thingiverse.com, cults3d.com) and there is no setting
 *     to add to it — a self-hosted instance can never be on that list. See
 *     docs/prusaslicer.md.
 *   - So the file is fetched by a small helper the printer owner installs
 *     once (`scripts/prusa-open.sh`), which hands PrusaSlicer a *local* path.
 *     A local file has no domain to check, so the allowlist never applies —
 *     that is the design, not a loophole.
 *
 * This link therefore adds nothing to the server and needs no client bundle:
 * clicking it invokes the OS protocol handler, which is not a fetch, so the
 * CSP does not govern it and there is no JavaScript here. On a machine with no
 * helper installed the click simply does nothing — the copy says as much, and
 * links to the one-time setup.
 *
 * The link carries only the numeric id. The base URL and the credential live
 * in the helper's own config on the owner's machine, never in the page.
 */
export function OpenInSlicer({ storyId }: { storyId: number }) {
  return (
    <details className="group mt-[13.2px]">
      <summary className="stamp inline-flex cursor-pointer list-none items-center gap-[8px] rounded-chip border-[3px] border-ink bg-porcelain px-[15px] py-[8px] text-[14px] font-bold text-ink hover:bg-sun">
        {/* An unadorned wedge, not a brand mark — nothing here claims to be Prusa's. */}
        <span aria-hidden className="font-mono text-[15px] leading-none">▸</span>
        Open in PrusaSlicer
      </summary>

      <div className="mt-[8.8px] rounded-card border-[3px] border-ink bg-cream-2 p-[13.2px]">
        <a
          href={`ppp://slice/${storyId}`}
          className="stamp inline-block cursor-pointer rounded-chip border-[3px] border-ink bg-cherry-dk px-[18px] py-[8px] text-[14px] font-bold text-cream hover:bg-cherry"
        >
          Send {storyRef(storyId)} to the slicer
        </a>
        <p className="m-0 mt-[8.8px] font-mono text-[11px] leading-[1.5] text-ink-2">
          Opens PrusaSlicer on <strong>this</strong> machine. Needs the one-time
          helper — see{" "}
          <a
            href="https://github.com/danileau/prettypleaseprint/blob/main/docs/prusaslicer.md"
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-cherry-dk"
          >
            the setup
          </a>
          . Nothing happens if it is not installed.
        </p>
      </div>
    </details>
  );
}
