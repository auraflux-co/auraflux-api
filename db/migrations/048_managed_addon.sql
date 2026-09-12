-- Migration 048: Managed as add-on on Creator/Studio (not a third replacement plan)
-- Stripe line item STRIPE_PRICE_MANAGED_ADDON; keep base tier growth|operate.

ALTER TABLE client_plans
  ADD COLUMN IF NOT EXISTS managed_addon BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN client_plans.managed_addon IS
  'True when Managed DFY add-on is attached to Creator/Studio (or legacy managed tier).';
