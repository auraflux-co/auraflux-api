-- 020_stripe_customer_id.sql — Persist Stripe Customer ID (CPD-381)
--
-- Stores the Stripe Customer ID against each client_plans row so that all
-- Stripe flows (subscription checkout, pack checkout, payment method, invoices,
-- auto top-up) share the same customer object instead of creating duplicates.

ALTER TABLE client_plans
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_client_plans_stripe_customer_id
  ON client_plans (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('020_stripe_customer_id') ON CONFLICT DO NOTHING;
