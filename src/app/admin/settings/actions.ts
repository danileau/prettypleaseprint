"use server";

import { redirect } from "next/navigation";

import { auditRow } from "@/lib/audit";
import { requireAdmin } from "@/lib/authz";
import { db } from "@/lib/db";
import { requireFreshAuth } from "@/lib/reauth";
import {
  DisplayName,
  SETTINGS_ID,
  SETTING_KEYS,
  SettingsInput,
  effectiveSettings,
  knownSources,
  lockedFields,
  resolveSettings,
  type SettingKey,
  type SettingsRow,
} from "@/lib/settings";

/**
 * Back to the page with what happened, as a code the page words — never words
 * in the URL, for the reason given in ../mail/actions.ts.
 */
export type SaveOutcome = "saved" | "unchanged" | "locked" | "invalid" | "unknown";

function back(outcome: SaveOutcome, field?: SettingKey): never {
  redirect(`/admin/settings?result=${outcome}${field ? `&field=${field}` : ""}`);
}

/** Thrown inside the transaction to roll it back when a save changes nothing. */
const NOTHING_CHANGED = new Error("nothing changed");

const isKey = (s: string): s is SettingKey => (SETTING_KEYS as readonly string[]).includes(s);

/**
 * A text field. Empty, or exactly what the field shows when nothing is saved,
 * means "nothing saved" — so pressing Save on an untouched page does not turn
 * a default into a stored value that would then outlive a change of default.
 */
function text(formData: FormData, name: string, unsaved: string | null): string | null {
  const raw = formData.get(name);
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value === "" || value === unsaved ? null : value;
}

type Stored = NonNullable<SettingsRow>;

/**
 * What a field held in the row that was not in force: a stored name that
 * fails validation, or import sources this version does not know. A save that
 * clears it says so on the trail, rather than it vanishing unrecorded.
 */
function ignored(field: SettingKey, before: Stored): unknown {
  if (field === "importSources") {
    const unknown = before.importSources.filter((s) => !knownSources([s]).length);
    return unknown.length ? unknown : undefined;
  }
  const value = before[field];
  return value !== null && !DisplayName.safeParse(value).success ? value : undefined;
}

/**
 * Save the owner's settings.
 *
 * Owner-only, like every admin action — the role is checked here, not
 * inferred from having been shown the page. Then a fresh sign-in, the same
 * gate as handing out access: one of these settings, importing from a link,
 * makes the server fetch from another site on a requester's say-so, and a
 * stolen twenty-minute cookie should not be enough to switch that on.
 *
 * The form says which fields it carries (`fields`), so a field that is not on
 * it is left alone rather than read as "cleared". A field the environment has
 * pinned is refused outright, not silently skipped: the page never offers it,
 * so a request that names one was not made by the page.
 *
 * The change and its `settings.changed` row are written in one transaction.
 * This is the one place a missing trail row is not acceptable (the owner's
 * condition on #104): the setting does not change unless the row is written.
 * Whether a field changed is decided on what is stored, so clearing a value
 * that was stored but ignored is a change, and is recorded. The row carries
 * every changed field's value in force before and after, and what was cleared
 * without having been in force; a save that changes nothing writes nothing.
 *
 * The settings row is locked for the length of the transaction, so two saves
 * at once are taken one after the other: the second reads what the first
 * wrote, and the trail's "from" values form an unbroken chain.
 */
export async function saveSettingsAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  await requireFreshAuth("/admin/settings");

  const names = formData.getAll("fields").map(String);
  if (!names.every(isKey)) back("unknown");
  const fields = [...new Set(names)] as SettingKey[];
  // Nothing named, nothing to do — and nothing written, not even an empty row.
  if (fields.length === 0) back("unchanged");

  const locked = lockedFields(await effectiveSettings());
  const pinned = fields.find((f) => locked.has(f));
  if (pinned) back("locked", pinned);

  // What each text field shows when nothing is saved — which, for the mail
  // name, depends on MAIL_FROM.
  const unsaved = resolveSettings(null);
  const raw: Record<string, unknown> = {};
  for (const field of fields) {
    raw[field] =
      field === "importSources"
        ? formData.getAll("importSources").map(String)
        : text(formData, field, unsaved[field].value);
  }
  const parsed = SettingsInput.safeParse(raw);
  if (!parsed.success) back("invalid", parsed.error.issues[0]?.path[0] as SettingKey | undefined);
  const input = parsed.data;

  let changed = true;
  try {
    await db.$transaction(async (tx) => {
      // Make sure there is a row to lock, then lock it: a concurrent save waits
      // here until this one commits, and then reads what it wrote.
      await tx.$executeRaw`
        INSERT INTO "instanceSettings" ("id", "updatedAt") VALUES (${SETTINGS_ID}, now())
        ON CONFLICT ("id") DO NOTHING`;
      const [row] = await tx.$queryRaw<Stored[]>`
        SELECT "passkeyRpName", COALESCE("importSources", ARRAY[]::TEXT[]) AS "importSources", "mailFromName"
        FROM "instanceSettings" WHERE "id" = ${SETTINGS_ID} FOR UPDATE`;
      const before: Stored = row!;
      const next: Stored = { ...before, ...input };

      const effectiveBefore = resolveSettings(before);
      const effectiveAfter = resolveSettings(next);
      const changes: Record<string, { from: unknown; to: unknown; cleared?: unknown }> = {};
      for (const field of fields) {
        if (JSON.stringify(before[field]) === JSON.stringify(next[field])) continue;
        const cleared = ignored(field, before);
        changes[field] = {
          from: effectiveBefore[field].value,
          to: effectiveAfter[field].value,
          ...(cleared === undefined ? {} : { cleared }),
        };
      }
      // Nothing changed: roll the whole transaction back, so the row inserted
      // above to have something to lock is not left behind on its own.
      if (Object.keys(changes).length === 0) throw NOTHING_CHANGED;

      await tx.instanceSettings.update({ where: { id: SETTINGS_ID }, data: input });
      await tx.auditEvent.create({
        data: await auditRow({
          action: "settings.changed",
          actor: admin,
          subject: SETTINGS_ID,
          detail: { changes },
        }),
      });
    });
  } catch (error) {
    if (error !== NOTHING_CHANGED) throw error;
    changed = false;
  }

  back(changed ? "saved" : "unchanged");
}
