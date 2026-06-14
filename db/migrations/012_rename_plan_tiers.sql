-- Migration 012: Rename plan tier identifiers diy/dwy/dfy → operate/guided/managed
-- CPD-176: Align internal keys with external brand names

-- client_plans.tier — drop old CHECK, update data, add new CHECK
ALTER TABLE client_plans DROP CONSTRAINT IF EXISTS client_plans_tier_check;

UPDATE client_plans SET tier = 'operate' WHERE tier = 'diy';
UPDATE client_plans SET tier = 'guided'  WHERE tier = 'dwy';
UPDATE client_plans SET tier = 'managed' WHERE tier = 'dfy';

ALTER TABLE client_plans
  ADD CONSTRAINT client_plans_tier_check
  CHECK (tier IN ('operate','guided','managed','custom'));

-- credit_ledger.tier if present
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'credit_ledger' AND column_name = 'tier'
  ) THEN
    UPDATE credit_ledger SET tier = 'operate' WHERE tier = 'diy';
    UPDATE credit_ledger SET tier = 'guided'  WHERE tier = 'dwy';
    UPDATE credit_ledger SET tier = 'managed' WHERE tier = 'dfy';
  END IF;
END $$;

-- api_keys.plan_tier default
ALTER TABLE api_keys ALTER COLUMN plan_tier SET DEFAULT 'operate';
UPDATE api_keys SET plan_tier = 'operate' WHERE plan_tier = 'diy';
UPDATE api_keys SET plan_tier = 'guided'  WHERE plan_tier = 'dwy';
UPDATE api_keys SET plan_tier = 'managed' WHERE plan_tier = 'dfy';

-- test seed data client IDs
UPDATE client_plans SET client_id = 'test_client_operate' WHERE client_id = 'test_client_diy';
UPDATE client_plans SET client_id = 'test_client_guided'  WHERE client_id = 'test_client_dwy';
UPDATE client_plans SET client_id = 'test_client_managed' WHERE client_id = 'test_client_dfy';
