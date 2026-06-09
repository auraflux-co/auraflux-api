-- 028_brand_profiles.sql
-- Multi-brand support: one customer can manage multiple brand profiles,
-- each with its own platform connections, source channels, and publishing settings.

CREATE TABLE IF NOT EXISTS brand_profiles (
  id              TEXT        PRIMARY KEY DEFAULT ('bp_' || substr(md5(random()::text), 1, 16)),
  customer_id     TEXT        NOT NULL,
  profile_name    TEXT        NOT NULL,   -- "natashaughey", "martinezofwonkru", etc.
  display_name    TEXT,                   -- "Natasha Hughey", optional friendly name
  avatar_url      TEXT,                   -- profile avatar
  source_channels JSONB       DEFAULT '{}'::jsonb,  -- same structure as client_plans.source_channels
  is_default      BOOLEAN     DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, profile_name)
);

CREATE INDEX IF NOT EXISTS idx_brand_profiles_customer ON brand_profiles (customer_id);

-- Migrate existing tokens to use profile_id
-- First, drop the old unique constraint
ALTER TABLE platform_oauth_tokens DROP CONSTRAINT IF EXISTS platform_oauth_tokens_customer_id_platform_key;

-- Add profile_id column (nullable for now during migration)
ALTER TABLE platform_oauth_tokens ADD COLUMN IF NOT EXISTS profile_id TEXT;

-- Create new unique constraint on profile_id + platform
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_tokens_profile_platform 
  ON platform_oauth_tokens (profile_id, platform) 
  WHERE profile_id IS NOT NULL;

-- For backwards compatibility: if profile_id is NULL, keep unique per customer
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_tokens_customer_platform 
  ON platform_oauth_tokens (customer_id, platform) 
  WHERE profile_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_profile ON platform_oauth_tokens (profile_id);

INSERT INTO schema_migrations (version) VALUES ('028_brand_profiles') ON CONFLICT DO NOTHING;
