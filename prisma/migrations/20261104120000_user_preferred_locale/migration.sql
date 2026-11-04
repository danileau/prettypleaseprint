-- The language a person chooses (#103). One nullable column and nothing else:
-- null is "no choice", which is every existing account. Nothing reads or
-- writes it yet; the choice on /me will.
--
-- Additive on purpose: the deploy wizard rolls back to the previous image
-- when a deploy fails its health check, and it does not undo migrations. That
-- image's client names its columns, has never heard of this one, and reads
-- and writes users exactly as before.
ALTER TABLE "user" ADD COLUMN "preferredLocale" TEXT;
