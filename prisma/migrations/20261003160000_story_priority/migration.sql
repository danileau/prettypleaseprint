-- How much a print request matters to the person asking, the way a feature
-- request has carried it since FRR-104.
--
-- Additive, with a default, so the previous image is untouched by it: its
-- client neither selects the column nor names it on insert, and a ticket it
-- files after a rollback simply comes out `medium`. Its own enum type rather
-- than a second use of "FeaturePriority", because the two backlogs are kept
-- parallel on purpose and a shared type would tie a change in one to the other.
CREATE TYPE "StoryPriority" AS ENUM ('low', 'medium', 'high');

ALTER TABLE "story" ADD COLUMN "priority" "StoryPriority" NOT NULL DEFAULT 'medium';
