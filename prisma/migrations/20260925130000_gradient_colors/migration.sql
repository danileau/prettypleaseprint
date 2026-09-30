ALTER TABLE "catalogColor" ADD COLUMN "style" TEXT;
UPDATE "catalogColor" SET "style" = "hex";
UPDATE "catalogColor"
SET "style" = 'linear-gradient(135deg, #e4322f 0%, #f6c945 20%, #43aa8b 40%, #2787c9 60%, #7557c7 80%, #e4328c 100%)',
    "hex" = '#7557c7'
WHERE lower("name") = 'whatever''s on';
ALTER TABLE "catalogColor" ALTER COLUMN "style" SET NOT NULL;

ALTER TABLE "story" ADD COLUMN "colorStyle" TEXT;
UPDATE "story" SET "colorStyle" = "colorHex";
UPDATE "story"
SET "colorStyle" = 'linear-gradient(135deg, #e4322f 0%, #f6c945 20%, #43aa8b 40%, #2787c9 60%, #7557c7 80%, #e4328c 100%)',
    "colorHex" = '#7557c7'
WHERE lower("colorName") = 'whatever''s on';
