-- Stripe webhook idempotency table — CPD-45
-- Stores processed Stripe event IDs to prevent double-crediting on retry.

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id    TEXT        PRIMARY KEY,
  event_type  TEXT        NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_migrations (version) VALUES ('004_stripe_events')
  ON CONFLICT (version) DO NOTHING;
