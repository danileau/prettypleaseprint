import Link from "next/link";

import { db } from "@/lib/db";
import type { Actor } from "@/lib/scope";
import { relativeTime } from "@/lib/catalog";
import { Brand } from "@/components/ui";
import { ActivityMenu, type FeedItem } from "@/components/activity-menu";
import { UserMenu } from "@/components/user-menu";
import { PasskeyNudge } from "@/components/passkey-nudge";

/**
 * The sign over the counter, on every screen.
 *
 * Dark ground, lit wordmark, chrome trim, and a checkerboard hairline where it
 * meets the room. `data-authenticated` is a stable hook for the test suites so
 * they assert on "there is a signed-in shell here" rather than on a piece of
 * copy that a redesign can move — which is exactly what went wrong before.
 */
const NAV: Record<Actor["role"], Array<{ label: string; href: string }>> = {
  client: [
    { label: "The rail", href: "/board" },
    { label: "Order up", href: "/upload" },
    { label: "My orders", href: "/me" },
    { label: "History", href: "/history" },
    { label: "Feature requests", href: "/frr" },
  ],
  admin: [
    { label: "The pass", href: "/queue" },
    { label: "The rail", href: "/board" },
    { label: "The books", href: "/me" },
    { label: "History", href: "/history" },
    // The board, not the triage queue: the owner wants to see everything that
    // has been asked for, and triage is one button away on that page.
    { label: "Feature requests", href: "/frr" },
    { label: "Benefits", href: "/admin/benefits" },
    { label: "Guest list", href: "/admin/invites" },
    { label: "Audit", href: "/admin/audit" },
  ],
};

export async function AppHeader({
  user,
  active,
}: {
  user: Actor;
  active: string;
}) {
  const [notifications, passkeyCount] = await Promise.all([
    db.notification.findMany({
      where: { recipientId: user.id },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    db.passkey.count({ where: { userId: user.id } }),
  ]);

  const items: FeedItem[] = notifications.map((n) => ({
    id: n.id,
    text: n.text,
    when: relativeTime(n.createdAt),
    read: n.read,
    storyId: n.storyId,
    featureId: n.featureId,
  }));
  const unread = items.filter((i) => !i.read).length;

  return (
    <header data-authenticated="true" className="sticky top-0 z-40">
      <div className="layers border-b-[3px] border-ink bg-ink">
        {/* Two tiers on a phone, one row on desktop. The nav takes `order-last
            w-full` so it drops to its own line below the brand and the account
            controls on narrow screens; from `lg` it returns inline
            (`lg:order-none lg:w-auto`) for the original single-row bar. The
            account cluster is pushed right with `ml-auto` rather than a
            flex-1 spacer, which was what scattered the wrapped layout. */}
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-x-[16px] gap-y-[11px] px-[16px] py-[11px] sm:px-[26.4px] sm:py-[13.2px] lg:gap-x-[22px]">
          <Link href={user.role === "admin" ? "/queue" : "/board"} aria-label="Pretty Please Print, home">
            {/* On the dark bar the script reads cream, not cherry. */}
            <span className="[&_span]:text-cream">
              <Brand size={34} />
            </span>
          </Link>

          <nav className="order-last flex w-full flex-wrap items-center gap-[6px] lg:order-none lg:w-auto">
            {NAV[user.role].map((item) => {
              const current = item.href === active;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={current ? "page" : undefined}
                  className={`rounded-chip border-2 px-[13px] py-[8px] font-mono text-[12.5px] font-bold uppercase tracking-[0.08em] transition-colors sm:px-[15px] sm:py-[7px] ${
                    current
                      ? "border-ink bg-sun text-ink"
                      : "border-transparent text-cream hover:border-ink hover:bg-cream-2 hover:text-ink"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-[8.8px] sm:gap-[13.2px]">
            <ActivityMenu
              items={items}
              unread={unread}
              title={user.role === "admin" ? "New from the group" : "Updates on your prints"}
            />
            <UserMenu
              name={user.name}
              initials={user.initials}
              email={user.email}
              role={user.role}
              passkeyCount={passkeyCount}
            />
          </div>
        </div>
      </div>

      {/* Chrome trim, then the checkerboard floor line. */}
      <div className="h-[5px] bg-chrome" aria-hidden />
      <div className="checker h-[8px] border-b-[3px] border-ink" aria-hidden />

      {passkeyCount === 0 && <PasskeyNudge />}
    </header>
  );
}
