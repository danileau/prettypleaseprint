-- Username + password login.
--
-- Both columns belong to Better Auth's username plugin. `username` is
-- nullable because an account can exist before it has one: the seeded admin
-- is written straight through Prisma and picks a username on the
-- set-password link the seed prints.
--
-- The unique index is what makes the login identifier unambiguous. Values are
-- folded to lower case on write, so it is case-insensitive in practice.
ALTER TABLE "user" ADD COLUMN "username" TEXT;
ALTER TABLE "user" ADD COLUMN "displayUsername" TEXT;

CREATE UNIQUE INDEX "user_username_key" ON "user"("username");
