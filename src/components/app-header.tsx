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
    { label: "Requests", href: "/frr" },
  ],
  admin: [
    { label: "The pass", href: "/queue" },
    { label: "The rail", href: "/board" },
    { label: "The books", href: "/me" },
    { label: "Requests", href: "/frr/queue" },
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
        <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-[22px] px-[26.4px] py-[13.2px]">
          <Link href={user.role === "admin" ? "/queue" : "/board"} aria-label="Pretty Please Print, home">
            {/* On the dark bar the script reads cream, not cherry. */}
            <span className="[&_span]:text-cream">
              <Brand size={34} />
            </span>
          </Link>

          <nav className="flex flex-wrap items-center gap-[6px]">
            {NAV[user.role].map((item) => {
              const current = item.href === active;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={current ? "page" : undefined}
                  className={`rounded-chip border-2 px-[15px] py-[7px] font-mono text-[12.5px] font-bold uppercase tracking-[0.08em] transition-colors ${
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

          <div className="flex-1" />

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

      {/* Chrome trim, then the checkerboard floor line. */}
      <div className="h-[5px] bg-chrome" aria-hidden />
      <div className="checker h-[8px] border-b-[3px] border-ink" aria-hidden />

      {passkeyCount === 0 && <PasskeyNudge />}
    </header>
  );
}
