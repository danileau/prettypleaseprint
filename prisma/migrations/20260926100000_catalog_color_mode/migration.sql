-- Swatch behaviour is data, not a magic spelling of the editable label.
CREATE TYPE "CatalogColorMode" AS ENUM ('solid', 'gradient', 'whatever');

ALTER TABLE "catalogColor" ADD COLUMN "mode" "CatalogColorMode" NOT NULL DEFAULT 'solid';
UPDATE "catalogColor"
SET "mode" = (CASE
  WHEN "style" = 'linear-gradient(135deg, #e4322f 0%, #f6c945 20%, #43aa8b 40%, #2787c9 60%, #7557c7 80%, #e4328c 100%)' THEN 'whatever'
  WHEN "style" LIKE 'linear-gradient(%' THEN 'gradient'
  ELSE 'solid'
END)::"CatalogColorMode";

ALTER TABLE "story" ADD COLUMN "colorMode" "CatalogColorMode" NOT NULL DEFAULT 'solid';
UPDATE "story"
SET "colorMode" = (CASE
  WHEN "colorStyle" = 'linear-gradient(135deg, #e4322f 0%, #f6c945 20%, #43aa8b 40%, #2787c9 60%, #7557c7 80%, #e4328c 100%)' THEN 'whatever'
  WHEN "colorStyle" LIKE 'linear-gradient(%' THEN 'gradient'
  ELSE 'solid'
END)::"CatalogColorMode";
