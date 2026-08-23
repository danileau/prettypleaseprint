-- "Roles: exactly one `admin` (the printer owner) plus `client` users."
--
-- Application code already refuses to mint a second admin, but application
-- code is one bug away from being wrong. A partial unique index makes a
-- second admin row impossible at the storage layer: the index covers only
-- rows where role = 'admin', so it permits any number of clients while
-- allowing exactly one admin.
-- Indexing the enum column itself: every row the index covers holds the same
-- value ('admin'), so uniqueness over it permits exactly one such row.
CREATE UNIQUE INDEX "user_single_admin"
  ON "user" (role)
  WHERE role = 'admin';

-- One open invite per address at a time. Accepted and revoked invites drop
-- out of the index, so an address can be re-invited after either.
CREATE UNIQUE INDEX "invite_one_open_per_email"
  ON "invite" (email)
  WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;
