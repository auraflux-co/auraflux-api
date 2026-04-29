-- Stripe subscription fields on client_plans — CPD-46
-- Required for metered overage billing: subscription item ID is needed
-- to report usage records to Stripe.

ALTER TABLE client_plans
  ADD COLUMN IF NOT EXISTS stripe_subscription_id   TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS stripe_metered_item_id   TEXT DEFAULT NULL;

-- billing_periods: track when overage has been reported to Stripe
ALTER TABLE billing_periods
  ADD COLUMN IF NOT EXISTS overage_reported_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS stripe_usage_record_id TEXT DEFAULT NULL;

-- Allow 'reported' as a status (period reported to Stripe but not yet invoiced)
ALTER TABLE billing_periods
  DROP CONSTRAINT IF EXISTS billing_periods_status_check;
ALTER TABLE billing_periods
  ADD CONSTRAINT billing_periods_status_check
    CHECK (status IN ('open','reported','closed','invoiced'));

INSERT INTO schema_migrations (version) VALUES ('005_stripe_subscription')
  ON CONFLICT (version) DO NOTHING;
