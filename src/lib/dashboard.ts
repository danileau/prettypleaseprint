import "server-only";
import type { StoryStatus } from "@prisma/client";

import { db } from "@/lib/db";
import { BOARD, storyRef } from "@/lib/scope";

/**
 * The numbers behind `/admin/audit`.
 *
 * Aggregation only: nothing here writes, nothing here is collected specially
 * for it, and no column exists because of it. The audit trail is a log rather
 * than a warehouse, so the panels that are really about the *work* — what gets
 * asked for, how big it is — read `Story` directly, and only the panels about
 * *events* read `AuditEvent`. Mixing those up is how a log slowly turns into a
 * schema nobody meant to design.
 *
 * Everything is scoped to the printer owner by the page that calls it; these
 * functions are unscoped on purpose, because there is exactly one admin and
 * `/admin/audit` is the only caller.
 */

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// 1. Refusals — the security half
// ---------------------------------------------------------------------------

/**
 * Every verb that means "somebody was told no".
 *
 * `file.refused` belongs here and was missing from the page's original set,
 * which is the one worth having: it fires when an account asks for a model it
 * may not see. One is a typo; a run of them walking consecutive ids is the
 * shape of somebody looking around, and it was the refusal least likely to be
 * noticed.
 */
export const REFUSAL_ACTIONS = [
  "invite.rejected",
  "upload.rejected",
  "file.refused",
] as const;

export type RefusalRow = {
  at: Date;
  action: string;
  subject: string | null;
  actorEmail: string | null;
  /** `upload.rejected` and `file.refused` both say why in `detail.reason`. */
  reason: string | null;
};

export type Refusals = {
  total: number;
  byAction: Array<{ action: string; count: number }>;
  /** Oldest day first, so it reads left to right like a calendar. */
  perDay: Array<{ day: Date; count: number }>;
  recent: RefusalRow[];
  days: number;
};

export async function refusals(days = 14): Promise<Refusals> {
  const since = new Date(Date.now() - days * DAY_MS);
  const rows = await db.auditEvent.findMany({
    where: { action: { in: [...REFUSAL_ACTIONS] }, at: { gte: since } },
    orderBy: { at: "desc" },
    select: { at: true, action: true, subject: true, actorEmail: true, detail: true },
  });

  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.action, (counts.get(r.action) ?? 0) + 1);

  // Buckets by calendar day, including the empty ones — a gap is information.
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const perDay = Array.from({ length: days }, (_, i) => {
    const day = new Date(startOfToday.getTime() - (days - 1 - i) * DAY_MS);
    const end = new Date(day.getTime() + DAY_MS);
    return {
      day,
      count: rows.filter((r) => r.at >= day && r.at < end).length,
    };
  });

  return {
    total: rows.length,
    byAction: [...counts.entries()]
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count),
    perDay,
    recent: rows.slice(0, 8).map((r) => ({
      at: r.at,
      action: r.action,
      subject: r.subject,
      actorEmail: r.actorEmail,
      reason:
        r.detail && typeof r.detail === "object" && "reason" in r.detail
          ? String((r.detail as { reason?: unknown }).reason ?? "")
          : null,
    })),
    days,
  };
}

// ---------------------------------------------------------------------------
// 2. Where the work is sitting
// ---------------------------------------------------------------------------

export type Stage = {
  status: StoryStatus;
  /** How many tickets are in this stage right now. */
  waiting: number;
  /** How long the longest-waiting one has been here, in hours. */
  longestHours: number | null;
  /** What this stage has typically taken, historically. */
  medianHours: number | null;
};

/**
 * Queue depth now, and how long this stage usually takes.
 *
 * The second number is the one worth having: depth alone cannot tell you
 * whether three tickets in *Requested* means the owner is slow to say yes or
 * simply that three arrived this morning. A median next to it can.
 *
 * Durations are reconstructed from the trail rather than stored: every
 * `story.status_changed` records the stage it came `from`, so consecutive
 * events on one ticket close the stage before them, and `story.created` opens
 * the first. Nothing had to be added to the schema for this — the trail was
 * already carrying it.
 */
export async function stages(): Promise<Stage[]> {
  const [open, events] = await Promise.all([
    db.story.findMany({
      where: { status: { in: [...BOARD] } },
      select: { id: true, status: true, createdAt: true },
    }),
    db.auditEvent.findMany({
      where: { action: { in: ["story.created", "story.status_changed"] } },
      orderBy: { at: "asc" },
      select: { at: true, action: true, subject: true, detail: true },
    }),
  ]);

  // Group the trail by ticket, in time order.
  const timeline = new Map<string, Array<{ at: Date; from: string | null }>>();
  for (const e of events) {
    if (!e.subject) continue;
    const from =
      e.action === "story.status_changed" &&
      e.detail && typeof e.detail === "object" && "from" in e.detail
        ? String((e.detail as { from?: unknown }).from ?? "")
        : null;
    const list = timeline.get(e.subject) ?? [];
    list.push({ at: e.at, from });
    timeline.set(e.subject, list);
  }

  // Each move closes the stage it names, which began at the previous event.
  const durations = new Map<string, number[]>();
  const enteredCurrent = new Map<string, Date>();
  for (const [subject, list] of timeline) {
    for (let i = 1; i < list.length; i++) {
      const step = list[i]!;
      if (!step.from) continue;
      const hours = (step.at.getTime() - list[i - 1]!.at.getTime()) / 3_600_000;
      durations.set(step.from, [...(durations.get(step.from) ?? []), hours]);
    }
    enteredCurrent.set(subject, list[list.length - 1]!.at);
  }

  const median = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  };

  const now = Date.now();
  return BOARD.map((status) => {
    const here = open.filter((s) => s.status === status);
    const ages = here.map((s) => {
      // The trail knows when it arrived here; fall back to when it was filed,
      // which is right for anything that has never moved.
      const entered = enteredCurrent.get(storyRef(s.id)) ?? s.createdAt;
      return (now - entered.getTime()) / 3_600_000;
    });
    return {
      status,
      waiting: here.length,
      longestHours: ages.length ? Math.max(...ages) : null,
      medianHours: median(durations.get(status) ?? []),
    };
  });
}

// ---------------------------------------------------------------------------
// 3. What gets asked for
// ---------------------------------------------------------------------------

export type Tally = { label: string; count: number; hex?: string };

export type Mix = {
  total: number;
  materials: Tally[];
  colors: Tally[];
  /** Buckets, so "is anybody near the cap" is answerable at a glance. */
  sizes: Tally[];
  largestBytes: number;
};

/**
 * Filament and file size, straight off `Story`.
 *
 * The material and colour tallies are the ones that turn into a shopping list.
 * The size buckets are here for a narrower reason: the upload cap was raised to
 * 250 MB and the viewer stops previewing at 50 MB, and both of those were set
 * from reasoning rather than from what people actually upload. This is the
 * panel that says whether either number was right.
 */
export async function mix(): Promise<Mix> {
  const [materials, colors, sizes] = await Promise.all([
    db.story.groupBy({ by: ["material"], _count: { _all: true } }),
    db.story.groupBy({ by: ["colorName", "colorHex"], _count: { _all: true } }),
    db.story.findMany({ select: { fileSize: true } }),
  ]);

  const MB = 1024 * 1024;
  const buckets: Array<{ label: string; test: (n: number) => boolean }> = [
    { label: "under 1 MB", test: (n) => n < MB },
    { label: "1 – 10 MB", test: (n) => n >= MB && n < 10 * MB },
    { label: "10 – 50 MB", test: (n) => n >= 10 * MB && n < 50 * MB },
    { label: "over 50 MB", test: (n) => n >= 50 * MB },
  ];

  return {
    total: sizes.length,
    materials: materials
      .map((m) => ({ label: m.material, count: m._count._all }))
      .sort((a, b) => b.count - a.count),
    colors: colors
      .map((c) => ({ label: c.colorName, hex: c.colorHex, count: c._count._all }))
      .sort((a, b) => b.count - a.count),
    sizes: buckets.map((b) => ({
      label: b.label,
      count: sizes.filter((s) => b.test(s.fileSize)).length,
    })),
    largestBytes: sizes.reduce((m, s) => Math.max(m, s.fileSize), 0),
  };
}
