-- `Done` becomes the end of the flow, and `Delivery` the step before it.
--
-- The order was Requested → Accepted → Printing → Done → Delivery, where
-- `Done` meant "off the plate" and `Delivery` was terminal. That left the
-- board with nowhere to put finished work, so delivered tickets stayed on the
-- rail forever and the rail stopped meaning "what is still moving".
--
-- The new order is Requested → Accepted → Printing → Delivery → Done:
-- `Delivery` is printed and waiting to be collected, `Done` is handed over.
--
-- Existing rows therefore swap, because their MEANING is preserved by
-- swapping, not by leaving them alone:
--
--   old Done     "printed, not yet with you"  ->  new Delivery
--   old Delivery "with you, finished"         ->  new Done
--
-- One statement, and a CASE rather than two UPDATEs: a single UPDATE reads the
-- pre-update value for every row, so the two states cross over cleanly with no
-- temporary third value and no window where both mean the same thing.
--
-- The enum type itself is untouched. Postgres cannot reorder enum members
-- without rebuilding the type, and the order there carries no meaning — the
-- sequence lives in FLOW in src/lib/scope.ts.
UPDATE "story"
SET status = CASE status
  WHEN 'Done'::"StoryStatus"     THEN 'Delivery'::"StoryStatus"
  WHEN 'Delivery'::"StoryStatus" THEN 'Done'::"StoryStatus"
  ELSE status
END
WHERE status IN ('Done'::"StoryStatus", 'Delivery'::"StoryStatus");
