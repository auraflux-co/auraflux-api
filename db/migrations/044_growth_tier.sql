-- Migration 044: Allow Growth / Creator tier (growth)
-- Marketing checkout uses plan=growth; entitlements already define growth.

ALTER TABLE client_plans DROP CONSTRAINT IF EXISTS client_plans_tier_check;
ALTER TABLE client_plans
  ADD CONSTRAINT client_plans_tier_check
  CHECK (tier IN ('growth','operate','guided','managed','custom'));

ALTER TABLE user_profiles DROP CONSTRAINT IF EXISTS user_profiles_tier_check;
ALTER TABLE user_profiles
  ADD CONSTRAINT user_profiles_tier_check
  CHECK (plan_tier IN ('growth','operate','guided','managed','custom'));
