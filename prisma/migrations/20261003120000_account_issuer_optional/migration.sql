-- `account.issuer` stops being required, and uniqueness goes back to where it
-- was before the column existed.
--
-- Better Auth 1.7.0 through 1.7.2 required the column and a unique index on
-- (issuer, accountId). 1.7.3 withdrew both: it no longer writes `issuer` and
-- recognises an account by (providerId, accountId), as 1.6 did. Against a
-- NOT NULL column that means every insert into `account` fails — nobody can
-- be given a password — and the library refuses to start a request once it
-- notices.
--
-- Relaxed rather than dropped: the previous image's Prisma client still
-- selects the column, and the deploy wizard rolls back to that image when a
-- deploy fails its health check. Dropping it here would turn a failed deploy
-- into a rollback that cannot read an account.
--
-- One thing a rollback does not get for free: 1.7.1 looks an account up by
-- issuer, so a password first set under the newer version, which leaves it
-- NULL, cannot sign in on the older image. Existing accounts are untouched.
-- If a deployment is rolled back after people have joined, this puts them
-- right, and is harmless to run at any time:
--
--   UPDATE "account" SET "issuer" = 'local:' || "providerId" WHERE "issuer" IS NULL;
ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;

-- Rows written from here on carry a NULL issuer, and a unique index treats
-- NULLs as distinct, so (issuer, accountId) would stop constraining anything.
DROP INDEX IF EXISTS "account_issuer_accountId_key";
CREATE UNIQUE INDEX "account_providerId_accountId_key" ON "account"("providerId", "accountId");
