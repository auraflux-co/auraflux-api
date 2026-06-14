-- CPD-403: pending_subscriptions
-- Stores Stripe checkout sessions where a user paid on the marketing site before
-- creating a Clerk account. Claimed after sign-up via POST /api/credits/claim-checkout.
CREATE TABLE IF NOT EXISTS pending_subscriptions (
  id                     SERIAL PRIMARY KEY,
  email                  TEXT NOT NULL,
  plan                   TEXT NOT NULL,
  stripe_session_id      TEXT UNIQUE NOT NULL,
  stripe_subscription_id TEXT,
  stripe_customer_id     TEXT,
  claimed_by             TEXT,            -- Clerk user ID after claim
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  expires_at             TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days')
);

CREATE INDEX IF NOT EXISTS idx_pending_subs_email
  ON pending_subscriptions (email);
CREATE INDEX IF NOT EXISTS idx_pending_subs_claimed
  ON pending_subscriptions (claimed_by)
  WHERE claimed_by IS NULL;
