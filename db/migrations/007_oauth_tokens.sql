-- 007_oauth_tokens.sql
-- Per-customer OAuth token storage for direct platform publishing (CPD-86).
-- Tokens are encrypted at rest via AES-256-GCM in lib/services/token_store.js.

CREATE TABLE IF NOT EXISTS platform_oauth_tokens (
  id              SERIAL PRIMARY KEY,
  customer_id     TEXT        NOT NULL,
  platform        TEXT        NOT NULL,          -- 'youtube' | 'tiktok' | 'instagram'
  access_token    TEXT        NOT NULL,          -- AES-GCM encrypted
  refresh_token   TEXT,                          -- AES-GCM encrypted (may be null for short-lived)
  token_expiry    TIMESTAMPTZ,
  scope           TEXT,
  platform_user_id TEXT,                         -- channel_id / tiktok_user_id / ig_user_id
  platform_handle  TEXT,                         -- display name / @handle
  raw_meta        JSONB       DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_customer ON platform_oauth_tokens (customer_id);

-- YouTube daily quota tracking (resets midnight Pacific)
CREATE TABLE IF NOT EXISTS youtube_quota_log (
  id             SERIAL PRIMARY KEY,
  customer_id    TEXT        NOT NULL,
  quota_date     DATE        NOT NULL DEFAULT CURRENT_DATE,
  units_used     INTEGER     NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, quota_date)
);

INSERT INTO schema_migrations (version) VALUES ('007_oauth_tokens') ON CONFLICT DO NOTHING;
