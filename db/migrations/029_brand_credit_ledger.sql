-- Migration 029: add brand_id to credit_ledger and credit_packs
-- Enables per-brand credit tracking when sub-brands have their own plans.
-- Existing rows stay NULL (account-level) — no data loss.

ALTER TABLE credit_ledger
  ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES brands(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_credit_ledger_brand_id ON credit_ledger (brand_id)
  WHERE brand_id IS NOT NULL;

ALTER TABLE credit_packs
  ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES brands(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_credit_packs_brand_id ON credit_packs (brand_id)
  WHERE brand_id IS NOT NULL;

INSERT INTO schema_migrations (version)
VALUES ('029_brand_credit_ledger')
ON CONFLICT DO NOTHING;
