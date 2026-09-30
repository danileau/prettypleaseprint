-- Move request materials from a closed enum to a historical text snapshot.
ALTER TABLE "story" ALTER COLUMN "material" DROP DEFAULT;
ALTER TABLE "story" ALTER COLUMN "material" TYPE TEXT USING "material"::text;
ALTER TABLE "story" ALTER COLUMN "material" SET DEFAULT 'PETG';
DROP TYPE "Material";

CREATE TABLE "catalogMaterial" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "catalogMaterial_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "catalogColor" (
    "id" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hex" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "catalogColor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "catalogMaterial_name_key" ON "catalogMaterial"("name");
CREATE INDEX "catalogMaterial_active_sortOrder_idx" ON "catalogMaterial"("active", "sortOrder");
CREATE UNIQUE INDEX "catalogColor_materialId_name_key" ON "catalogColor"("materialId", "name");
CREATE INDEX "catalogColor_materialId_active_sortOrder_idx" ON "catalogColor"("materialId", "active", "sortOrder");
ALTER TABLE "catalogColor" ADD CONSTRAINT "catalogColor_materialId_fkey"
  FOREIGN KEY ("materialId") REFERENCES "catalogMaterial"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "catalogMaterial" ("id", "name", "sortOrder") VALUES
  ('catalog-material-pla', 'PLA', 0),
  ('catalog-material-petg', 'PETG', 1),
  ('catalog-material-tpu', 'TPU', 2),
  ('catalog-material-resin', 'Resin', 3);

INSERT INTO "catalogColor" ("id", "materialId", "name", "hex", "sortOrder")
SELECT 'catalog-color-' || lower(replace(m."name", ' ', '-')) || '-' || c.slug,
       m."id", c.name, c.hex, c.ord
FROM "catalogMaterial" m
CROSS JOIN (VALUES
  ('teal', 'Teal', '#12645f', 0),
  ('slate', 'Slate', '#4a5d78', 1),
  ('bone-white', 'Bone white', '#eaecee', 2),
  ('graphite', 'Graphite', '#1b2126', 3),
  ('whatever', 'Whatever''s on', '#b6bcc2', 4)
) AS c(slug, name, hex, ord);
