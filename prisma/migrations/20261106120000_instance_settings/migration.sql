-- The owner's settings page (#104): one row of instance-wide settings.
--
-- Additive: a new table and nothing else, so the previous image is untouched
-- by it — its client has no model for the table and never names it. No row is
-- created here; until the owner first saves /admin/settings every value is its
-- default, which is today's behaviour.
--
-- One row, enforced here rather than trusted to the app: the id can only ever
-- be 'instance', so a second row cannot exist to disagree with the first.
CREATE TABLE "instanceSettings" (
    "id" TEXT NOT NULL DEFAULT 'instance',
    "passkeyRpName" TEXT,
    "importSources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mailFromName" TEXT,
    "defaultLocale" TEXT,
    "defaultTheme" TEXT,
    "defaultSlicer" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instanceSettings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "instanceSettings_single_row" CHECK ("id" = 'instance')
);
