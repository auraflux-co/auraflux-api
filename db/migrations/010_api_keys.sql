-- Migration 010: API keys for Developer API (CPD-126)
-- Operate plan customers authenticate to /v1/ endpoints using long-lived API keys.
-- Keys are stored hashed (SHA-256); plaintext is shown once at creation and never stored.

CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   TEXT        NOT NULL,               -- Clerk user ID
  key_hash      TEXT        NOT NULL UNIQUE,         -- SHA-256 of the full key
  key_prefix    TEXT        NOT NULL,               -- first 12 chars e.g. "af_live_xyzw" for display
  name          TEXT        NOT NULL DEFAULT '',     -- human label e.g. "Production bot"
  plan_tier     TEXT        NOT NULL DEFAULT 'diy',  -- snapshotted at creation time
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ                          -- NULL = active
);

CREATE INDEX IF NOT EXISTS api_keys_customer_idx ON api_keys(customer_id);
CREATE INDEX IF NOT EXISTS api_keys_hash_idx     ON api_keys(key_hash);

INSERT INTO schema_migrations (version) VALUES ('010_api_keys') ON CONFLICT DO NOTHING;
