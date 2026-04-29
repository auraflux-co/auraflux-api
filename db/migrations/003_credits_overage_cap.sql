-- AuraFlux Credit Overage Cap — CPD-43
-- Adds overage_cap_credits column to client_plans so the consume endpoint
-- can PAUSE a job when the cap is reached.

ALTER TABLE client_plans
  ADD COLUMN IF NOT EXISTS overage_cap_credits INTEGER DEFAULT NULL;

-- Re-seed test clients with a cap for QA testing
UPDATE client_plans SET overage_cap_credits = 20  WHERE client_id = 'test_client_diy';
UPDATE client_plans SET overage_cap_credits = 50  WHERE client_id = 'test_client_dwy';
UPDATE client_plans SET overage_cap_credits = 200 WHERE client_id = 'test_client_dfy';

INSERT INTO schema_migrations (version) VALUES ('003_credits_overage_cap')
  ON CONFLICT (version) DO NOTHING;
