-- 047_brand_calendar_plan.sql
-- Per-brand monthly cadence plan for Creator Schedule month grid.

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS calendar_plan JSONB NOT NULL DEFAULT '{}'::jsonb;
