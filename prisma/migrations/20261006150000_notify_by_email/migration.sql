-- Whether a person wants their notifications by email as well as in the
-- Activity panel. On unless they switch it off.
--
-- Additive, with a default, so the previous image is untouched by it: its
-- client neither selects the column nor names it on insert, and an account it
-- creates after a rollback simply comes out `true`.
ALTER TABLE "user" ADD COLUMN "notifyByEmail" BOOLEAN NOT NULL DEFAULT true;
