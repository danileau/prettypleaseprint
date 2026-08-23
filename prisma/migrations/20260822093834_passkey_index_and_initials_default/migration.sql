-- AlterTable
ALTER TABLE "user" ALTER COLUMN "initials" SET DEFAULT '??';

-- CreateIndex
CREATE INDEX "passkey_credentialID_idx" ON "passkey"("credentialID");
