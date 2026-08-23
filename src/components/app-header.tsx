import Link from "next/link";

import { db } from "@/lib/db";
import type { Actor } from "@/lib/scope";
import { relativeTime } from "@/lib/catalog";
import { Brand } from "@/components/ui";
import { ActivityMenu, type FeedItem } from "@/components/activity-menu";
import { UserMenu } from "@/components/user-menu";
import { PasskeyNudge } from "@/components/passkey-nudge";

/**
 * The one header, on every screen. Handoff §1.
 *
 * Nav differs by role: the client gets Backlog / Upload / My prints, the
 * admin gets Queue / Board / their own prints. Routes that are not built yet
 * are omitted rather than rendered as dead links.
 */
const NAV: Record<Actor["role"], Array<{ label: string; href: string }>> = {
  client: [
    { label: "Backlog", href: "/board" },
    { label: "Upload", href: "/upload" },
  ],
  admin: [
    { label: "Board", href: "/board" },
    { label: "Guest list", href: "/admin/invites" },
    // "Audit", not "Activity" — the Activity button beside it is the
    // notification feed, and two things called Activity is one too many.
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
  }));
  const unread = items.filter((i) => !i.read).length;

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/90 backdrop-blur-[8px]">
      <div className="mx-auto flex max-w-[1180px] flex-wrap items-center gap-[26.4px] px-[26.4px] py-[14px]">
        <Link href="/board" aria-label="Pretty Please Print, home" className="text-ink">
          <Brand size={34} />
        </Link>

        <nav className="flex flex-wrap items-center gap-[4.4px]">
          {NAV[user.role].map((item) => {
            const current = item.href === active;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={`rounded-[8px] px-[17.6px] py-[8.8px] text-[15px] ${
                  current
                    ? "bg-teal font-bold text-teal-100"
                    : "font-semibold text-muted-3 hover:bg-teal-200 hover:text-teal-700"
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

      {/* Only for people still on emailed links. Gone for good once a
          passkey exists. */}
      {passkeyCount === 0 && <PasskeyNudge />}
    </header>
  );
}
