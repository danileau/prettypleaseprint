import { requireUser } from "@/lib/authz";
import { sourceUrl } from "@/lib/runtime";
import { CONTRIBUTORS, type Contributor } from "@/lib/contributors";
import { AppHeader } from "@/components/app-header";
import { Kicker } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * What this app is, and who made it.
 *
 * Behind sign-in like every other page: the unauthenticated surface is kept
 * deliberately small, and a list of names is not something a stranger needs.
 *
 * The names come from src/lib/contributors.ts, which `npm run contributors`
 * generates from main's history — not from git at render time, because the
 * container has no `.git` to read. Text links only, no avatars: the CSP's
 * `img-src` refuses github.com, and it should.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function month(since: string): string {
  const [y, m] = since.split("-");
  return `${MONTHS[Number(m) - 1] ?? "?"} ${y}`;
}

function Person({ person }: { person: Contributor }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-[13.2px] gap-y-[4px] border-b-2 border-dashed border-rule p-[15px] last:border-b-0">
      <a
        href={`https://github.com/${encodeURIComponent(person.login)}`}
        target="_blank"
        rel="noopener noreferrer"
        className="font-display text-[19px] leading-[1.2] text-ink underline decoration-2 underline-offset-[3px] hover:text-cherry-dk"
      >
        @{person.login}
      </a>
      {person.name && <span className="text-[15.5px] text-ink-2">{person.name}</span>}
      <span className="ml-auto font-mono text-[11px] uppercase tracking-[0.05em] text-ink-3">
        since {month(person.since)}
      </span>
    </li>
  );
}

export default async function AboutPage() {
  const user = await requireUser("/about");
  const source = sourceUrl();

  const maintainers = CONTRIBUTORS.filter((c) => c.role === "maintainer");
  const contributors = CONTRIBUTORS.filter((c) => c.role === "contributor");

  return (
    <>
      <AppHeader user={user} active="/about" />

      <main className="mx-auto w-full max-w-[860px] px-[26.4px] pb-[80px] pt-[35.2px]">
        <Kicker>About the place</Kicker>
        <h1 className="m-0 mb-[13.2px] text-[38px] leading-[1.05] text-ink">
          Pretty Please Print
        </h1>
        <p className="m-0 mb-[13.2px] text-[16.5px] leading-[1.55] text-ink-2 text-pretty">
          An invite-only counter for the office 3D printer: upload a model, ask
          nicely, and follow it from the order rail to the pass to your hands.
        </p>
        <p className="m-0 mb-[35.2px] text-[16.5px] leading-[1.55] text-ink-2 text-pretty">
          It is free software under the GNU Affero General Public License,
          version 3 or later. The source this instance runs is at{" "}
          <a
            href={source}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all font-mono text-[14.5px] text-ink underline underline-offset-2 hover:text-cherry-dk"
          >
            {source}
          </a>
          .
        </p>

        <h2 className="m-0 mb-[13.2px] font-display text-[26px] text-ink">
          Who made it
        </h2>
        <p className="m-0 mb-[17.6px] text-[15.5px] leading-[1.5] text-ink-2 text-pretty">
          Everyone whose code is in it, by their GitHub name. Thank you.
        </p>

        {maintainers.length > 0 && (
          <section className="mb-[26.4px]">
            <h3 className="m-0 mb-[8.8px] font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-ink-3">
              Behind the counter · maintainer
            </h3>
            <ul className="m-0 list-none overflow-hidden rounded-panel border-[3px] border-ink bg-sun-wash p-0 shadow-stamp">
              {maintainers.map((p) => (
                <Person key={p.login} person={p} />
              ))}
            </ul>
          </section>
        )}

        <section>
          <h3 className="m-0 mb-[8.8px] font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-ink-3">
            On the line · contributors
          </h3>
          {contributors.length === 0 ? (
            <p className="m-0 rounded-panel border-[3px] border-ink bg-porcelain p-[22px] font-mono text-[12px] uppercase tracking-[0.06em] text-ink-3 shadow-stamp">
              Nobody else yet — the door is open.
            </p>
          ) : (
            <ul className="m-0 list-none overflow-hidden rounded-panel border-[3px] border-ink bg-porcelain p-0 shadow-stamp">
              {contributors.map((p) => (
                <Person key={p.login} person={p} />
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}
