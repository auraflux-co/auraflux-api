-- CPD-369: auto top-up + stripe_customer_id on client_plans
-- auto_topup_enabled: customer opts in to automatic credit_topup pack purchase when balance hits 0
-- stripe_customer_id: populated from Stripe webhook sub.customer so we can charge off-session

ALTER TABLE client_plans
  ADD COLUMN IF NOT EXISTS auto_topup_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stripe_customer_id  TEXT;
