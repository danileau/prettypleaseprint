-- Where a model came from, when it was imported from a link rather than
-- uploaded. Null for every upload, and for every ticket filed before this.
--
-- Nullable and additive on purpose: the deploy wizard rolls back to the
-- previous image when a deploy fails its health check, and it does not undo
-- migrations. That image's client names its columns and has never heard of
-- this one, so it reads and writes tickets exactly as before.
ALTER TABLE "story" ADD COLUMN "sourceUrl" TEXT;
