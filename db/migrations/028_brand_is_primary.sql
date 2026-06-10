-- 028_brand_is_primary.sql
-- Full brand architecture (CPD-multi-brand)
--
-- 1. brands.is_primary — marks the first brand created per account as the
--    primary brand. The primary brand owns the brand switcher UI and acts
--    as the hub for all sub-brands under the same account.
--
-- 2. job_templates.brand_id — scopes templates to a specific brand so each
--    brand workspace has its own independent template library.

-- ── brands.is_primary ─────────────────────────────────────────────────────
ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;

-- Mark the oldest brand per account as primary (created_at ASC = first brand)
UPDATE brands b
SET is_primary = TRUE
WHERE b.created_at = (
  SELECT MIN(b2.created_at)
  FROM brands b2
  WHERE b2.account_id = b.account_id
);

-- Ensure exactly one primary per account (unique partial index)
CREATE UNIQUE INDEX IF NOT EXISTS idx_brands_one_primary_per_account
  ON brands (account_id)
  WHERE is_primary = TRUE;

-- ── job_templates.brand_id ────────────────────────────────────────────────
ALTER TABLE job_templates
  ADD COLUMN IF NOT EXISTS brand_id UUID;

ALTER TABLE job_templates
  ADD CONSTRAINT fk_job_templates_brand
    FOREIGN KEY (brand_id)
    REFERENCES brands(id)
    ON DELETE CASCADE;

-- Backfill: assign existing templates to the primary brand of that customer
UPDATE job_templates jt
SET brand_id = (
  SELECT b.id
  FROM brands b
  WHERE b.account_id = jt.customer_id
    AND b.is_primary = TRUE
  LIMIT 1
)
WHERE brand_id IS NULL
  AND EXISTS (
    SELECT 1 FROM brands WHERE account_id = jt.customer_id
  );

CREATE INDEX IF NOT EXISTS idx_job_templates_brand ON job_templates (brand_id);

INSERT INTO schema_migrations (version)
VALUES ('028_brand_is_primary')
ON CONFLICT DO NOTHING;
