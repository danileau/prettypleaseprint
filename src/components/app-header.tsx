import Link from "next/link";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";

import type en from "../../messages/en.json";
import { db } from "@/lib/db";
import type { Actor } from "@/lib/scope";
import { relativeTime } from "@/lib/catalog";
import { CLIENT_GROUPS } from "@/i18n/client-groups";
import { getClientMessages, relativeTimeVoice } from "@/i18n/server";
import { Brand } from "@/components/ui";
import { ActivityMenu, type FeedItem } from "@/components/activity-menu";
import { UserMenu } from "@/components/user-menu";
import { PasskeyNudge } from "@/components/passkey-nudge";
import { authMethods } from "@/lib/auth-methods";

/**
 * The sign over the counter, on every screen.
 *
 * Dark ground, lit wordmark, chrome trim, and a checkerboard hairline where it
 * meets the room. `data-authenticated` is a stable hook for the test suites so
 * they assert on "there is a signed-in shell here" rather than on a piece of
 * copy that a redesign can move — which is exactly what went wrong before.
 */
const NAV: Record<Actor["role"], Array<{ key: NavKey; href: string }>> = {
  client: [
    { key: "rail", href: "/board" },
    { key: "orderUp", href: "/upload" },
    { key: "myOrders", href: "/me" },
    { key: "history", href: "/history" },
    { key: "featureRequests", href: "/frr" },
  ],
  admin: [
    { key: "pass", href: "/queue" },
    { key: "rail", href: "/board" },
    { key: "books", href: "/me" },
    { key: "materials", href: "/admin/catalog" },
    { key: "history", href: "/history" },
    { key: "byPerson", href: "/admin/prints" },
    // The board, not the triage queue: the owner wants to see everything that
    // has been asked for, and triage is one button away on that page.
    { key: "featureRequests", href: "/frr" },
    { key: "benefits", href: "/admin/benefits" },
    { key: "guestList", href: "/admin/invites" },
    { key: "mail", href: "/admin/mail" },
    { key: "settings", href: "/admin/settings" },
    { key: "audit", href: "/admin/audit" },
  ],
};

/**
 * The labels are keys under `header.nav` in messages/. The diner's names —
 * the rail, the pass, the books — are for a translation to render as the words
 * a kitchen in that language would use, not word for word; docs/i18n.md says
 * where that reasoning is kept.
 */
type NavKey = keyof typeof en.header.nav;

export async function AppHeader({
  user,
  active,
}: {
  user: Actor;
  active: string;
}) {
  const [notifications, passkeyCount, t, clientMessages, timeVoice] = await Promise.all([
    db.notification.findMany({
      where: { recipientId: user.id },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    db.passkey.count({ where: { userId: user.id } }),
    getTranslations("header"),
    getClientMessages(CLIENT_GROUPS.header),
    relativeTimeVoice(),
  ]);

  // `text` is written once, in English, when the notification is created; it
  // is a sentence, not a message key, and stays English until notifications
  // store a key and its values instead. `when` is written here, in the
  // request's language, and reaches the menu as a finished string.
  const items: FeedItem[] = notifications.map((n) => ({
    id: n.id,
    text: n.text,
    when: relativeTime(n.createdAt, timeVoice),
    read: n.read,
    storyId: n.storyId,
    featureId: n.featureId,
  }));
  const unread = items.filter((i) => !i.read).length;

  return (
    // The menus and the nudge are client components: they get their words
    // from this provider, and only the groups listed for the header —
    // nothing the owner alone sees (src/i18n/client-groups.ts). `timeZone`
    // is set so the server's own is not written into the page; nothing on the
    // client formats a date through next-intl.
    <NextIntlClientProvider messages={clientMessages} timeZone="UTC">
      <header data-authenticated="true" className="sticky top-0 z-40">
        <div className="layers border-b-[3px] border-ink bg-ink">
          {/* Keep identity and account controls on a stable top row. Navigation
              has its own wrapping row, so adding destinations cannot push the
              activity or profile menus away from the wordmark. */}
          <div className="mx-auto max-w-[1180px] px-[16px] py-[11px] sm:px-[26.4px] sm:py-[13.2px]">
            <div className="flex items-center gap-[16px] lg:gap-[22px]">
              <Link href={user.role === "admin" ? "/queue" : "/board"} aria-label={t("home")}>
                {/* On the dark bar the script reads cream, not cherry. */}
                <span className="[&_span]:text-cream">
                  <Brand size={34} />
                </span>
              </Link>

              <div className="ml-auto flex items-center gap-[8.8px] sm:gap-[13.2px]">
                <ActivityMenu
                  items={items}
                  unread={unread}
                  title={t(user.role === "admin" ? "feedTitle.owner" : "feedTitle.member")}
                />
                <UserMenu
                  name={user.name}
                  initials={user.initials}
                  email={user.email}
                  roleLabel={t(user.role === "admin" ? "role.owner" : "role.member")}
                  passkeyCount={passkeyCount}
                />
              </div>
            </div>

            <nav className="mt-[11px] flex flex-wrap items-center gap-[6px]">
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
                    {t(`nav.${item.key}`)}
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>

        {/* Chrome trim, then the checkerboard floor line. */}
        <div className="h-[5px] bg-chrome" aria-hidden />
        <div className="checker h-[8px] border-b-[3px] border-ink" aria-hidden />

        {/* Nothing to nudge towards where passkeys are off. */}
        {passkeyCount === 0 && authMethods().local && <PasskeyNudge />}
      </header>
    </NextIntlClientProvider>
  );
}
