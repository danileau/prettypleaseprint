-- `account.issuer`, which Better Auth requires and this app never needed
-- until it had passwords.
--
-- Nothing had ever written an account row: passkeys live in their own table
-- and there is no OAuth provider, so the column and its uniqueness rule were
-- dead weight right up until a `credential` account had to exist. Backfilled
-- rather than added bare, so the migration is correct against a database that
-- somehow does hold rows.
ALTER TABLE "account" ADD COLUMN "issuer" TEXT;
UPDATE "account" SET "issuer" = 'local:' || "providerId" WHERE "issuer" IS NULL;
ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;

-- Uniqueness moves to (issuer, accountId): the issuer is the namespace, so it
-- is the half that makes an account id unambiguous.
DROP INDEX IF EXISTS "account_providerId_accountId_key";
CREATE UNIQUE INDEX "account_issuer_accountId_key" ON "account"("issuer", "accountId");
