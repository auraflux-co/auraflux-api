-- 045_creator_pipeline_extensions.sql
-- Creator pipeline extensions: brand creative profiles, guest review tokens, playlist strategy.

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS creative_profile JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS publish_strategy_rules JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS review_share_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  TEXT NOT NULL UNIQUE,
  job_id      TEXT NOT NULL,
  brand_id    UUID,
  account_id  TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  permissions JSONB NOT NULL DEFAULT '{"approve":true,"revise":true,"comment":true}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_review_share_tokens_job
  ON review_share_tokens (job_id);

CREATE INDEX IF NOT EXISTS idx_review_share_tokens_expires
  ON review_share_tokens (expires_at)
  WHERE revoked_at IS NULL;
