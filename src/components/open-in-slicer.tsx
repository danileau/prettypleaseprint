import { storyRef } from "@/lib/scope";
import { mintSlicerToken } from "@/lib/slicer-token";

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
 * The link carries the ticket id **and a short-lived credential minted for the
 * person reading this page**. It used to carry only the id, with a bearer token
 * pasted once into the helper's config — but that token was the session token,
 * so shortening sessions to twenty idle minutes stopped it working and the
 * helper started answering `HTTP 401`. Putting the credential in the link
 * rather than on disk fixes that and retires a thirty-day, full-authority
 * secret in a file at the same time. See `src/lib/slicer-token.ts`.
 *
 * Minted per render, so it is as fresh as the page. It is good for half an
 * hour, for this model only, and it authorises nothing on its own — the route
 * re-checks the account and re-applies `storyScope`.
 *
 * `DownloadModel` sits beside this rather than inside it: the same bytes with
 * no helper at all, for the printer owner who is not at the machine with the
 * slicer on it. Putting it behind this disclosure would have hidden the plain
 * answer behind the clever one.
 */
export function OpenInSlicer({
  storyId,
  userId,
}: {
  storyId: number;
  /** Who the link credential is minted for. */
  userId: string;
}) {
  const token = mintSlicerToken(userId, storyId);

  return (
    <details className="group mt-[13.2px]">
      <summary className="stamp inline-flex cursor-pointer list-none items-center gap-[8px] rounded-chip border-[3px] border-ink bg-porcelain px-[15px] py-[8px] text-[14px] font-bold text-ink hover:bg-sun">
        {/* An unadorned wedge, not a brand mark — nothing here claims to be Prusa's. */}
        <span aria-hidden className="font-mono text-[15px] leading-none">▸</span>
        Open in PrusaSlicer
      </summary>

      <div className="mt-[8.8px] rounded-card border-[3px] border-ink bg-cream-2 p-[13.2px]">
        <a
          href={`ppp://slice/${storyId}?t=${token}`}
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
          . Nothing happens if it is not installed — the download beside this
          works anywhere.
        </p>
      </div>
    </details>
  );
}
