-- AuraFlux Credit Ledger Schema — CPD-42
-- Token-based usage tracking for DIY/DWY/DFY billing tiers.
-- Run after 001_initial_schema.sql (schema_migrations guards idempotency).

-- ── Updated-at trigger (shared across tables that need it) ───────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Client Plans ─────────────────────────────────────────────────────────────
-- Source of truth for a client's billing tier and included credit allowance.

CREATE TABLE IF NOT EXISTS client_plans (
  id                  BIGSERIAL     PRIMARY KEY,
  client_id           TEXT          NOT NULL UNIQUE,
  tier                TEXT          NOT NULL CHECK (tier IN ('diy','dwy','dfy','custom')),
  credits_included    INTEGER       NOT NULL DEFAULT 0,
  overage_price_cents INTEGER       NOT NULL DEFAULT 0,   -- cents per credit beyond included
  billing_anchor_day  SMALLINT      NOT NULL DEFAULT 1 CHECK (billing_anchor_day BETWEEN 1 AND 28),
  stripe_customer_id  TEXT,
  stripe_price_id     TEXT,
  active              BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_plans_client ON client_plans(client_id);

DROP TRIGGER IF EXISTS trg_client_plans_updated_at ON client_plans;
CREATE TRIGGER trg_client_plans_updated_at
  BEFORE UPDATE ON client_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Credit Ledger ─────────────────────────────────────────────────────────────
-- Append-only event log. Never UPDATE or DELETE rows.
-- type: 'included'  — drawn from monthly allowance
--       'overage'   — billed at overage_price_cents / credit
--       'pack'      — drawn from a pre-purchased credit pack

CREATE TABLE IF NOT EXISTS credit_ledger (
  id            BIGSERIAL   PRIMARY KEY,
  client_id     TEXT        NOT NULL,
  job_id        TEXT,
  credits_used  INTEGER     NOT NULL CHECK (credits_used > 0),
  type          TEXT        NOT NULL CHECK (type IN ('included','overage','pack')),
  pack_id       BIGINT,                     -- FK to credit_packs when type='pack'
  billing_period_id BIGINT,                 -- FK to billing_periods (backfilled at period close)
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_client_time
  ON credit_ledger(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_job
  ON credit_ledger(job_id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_period
  ON credit_ledger(billing_period_id);

-- ── Credit Packs ─────────────────────────────────────────────────────────────
-- Pre-purchased one-time credit bundles.
-- FIFO consumption: ORDER BY expires_at ASC NULLS LAST, created_at ASC.

CREATE TABLE IF NOT EXISTS credit_packs (
  id                  BIGSERIAL     PRIMARY KEY,
  client_id           TEXT          NOT NULL,
  credits_purchased   INTEGER       NOT NULL CHECK (credits_purchased > 0),
  credits_remaining   INTEGER       NOT NULL CHECK (credits_remaining >= 0),
  expires_at          TIMESTAMPTZ,
  stripe_payment_id   TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_packs_client
  ON credit_packs(client_id, expires_at ASC NULLS LAST, created_at ASC);

DROP TRIGGER IF EXISTS trg_credit_packs_updated_at ON credit_packs;
CREATE TRIGGER trg_credit_packs_updated_at
  BEFORE UPDATE ON credit_packs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Billing Periods ───────────────────────────────────────────────────────────
-- Monthly summary; one row per (client_id, period_start).
-- Created at period open; closed/invoiced at period end.

CREATE TABLE IF NOT EXISTS billing_periods (
  id                  BIGSERIAL     PRIMARY KEY,
  client_id           TEXT          NOT NULL,
  period_start        DATE          NOT NULL,
  period_end          DATE          NOT NULL,
  credits_used        INTEGER       NOT NULL DEFAULT 0,
  overage_credits     INTEGER       NOT NULL DEFAULT 0,
  overage_charge_cents INTEGER      NOT NULL DEFAULT 0,
  stripe_invoice_id   TEXT,
  status              TEXT          NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','invoiced')),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_billing_periods_client
  ON billing_periods(client_id, period_start DESC);

DROP TRIGGER IF EXISTS trg_billing_periods_updated_at ON billing_periods;
CREATE TRIGGER trg_billing_periods_updated_at
  BEFORE UPDATE ON billing_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Seed — test clients (DIY / DWY / DFY) ────────────────────────────────────

INSERT INTO client_plans (client_id, tier, credits_included, overage_price_cents, billing_anchor_day)
VALUES
  ('test_client_diy',  'diy',  50,   25, 1),
  ('test_client_dwy',  'dwy',  200,  15, 1),
  ('test_client_dfy',  'dfy',  1000, 10, 1)
ON CONFLICT (client_id) DO NOTHING;

-- ── Schema Migration Tracker ──────────────────────────────────────────────────

INSERT INTO schema_migrations (version) VALUES ('002_credit_ledger')
  ON CONFLICT (version) DO NOTHING;
