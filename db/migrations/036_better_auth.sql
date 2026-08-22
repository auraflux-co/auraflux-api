-- Migration 036: Better Auth (replace Clerk) + stable account profiles
-- account_id is what brands/jobs/membership use. For migrated users it stays
-- the legacy Clerk user id so existing rows keep working.

CREATE TABLE IF NOT EXISTS "user" (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  image         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS session (
  id          TEXT PRIMARY KEY,
  expires_at  TIMESTAMPTZ NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address  TEXT,
  user_agent  TEXT,
  user_id     TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS session_user_id_idx ON session (user_id);

CREATE TABLE IF NOT EXISTS account (
  id                      TEXT PRIMARY KEY,
  account_id              TEXT NOT NULL,
  provider_id             TEXT NOT NULL,
  user_id                 TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token            TEXT,
  refresh_token           TEXT,
  id_token                TEXT,
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  scope                   TEXT,
  password                TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS account_user_id_idx ON account (user_id);

CREATE TABLE IF NOT EXISTS verification (
  id         TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- AuraFlux profile: maps Better Auth user → stable account_id + role/tier
CREATE TABLE IF NOT EXISTS user_profiles (
  auth_user_id     TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  account_id       TEXT NOT NULL UNIQUE,
  email            TEXT,
  role             TEXT NOT NULL DEFAULT 'customer',
  plan_tier        TEXT NOT NULL DEFAULT 'operate',
  legacy_clerk_id  TEXT UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_profiles_role_check CHECK (role IN ('customer', 'superadmin')),
  CONSTRAINT user_profiles_tier_check CHECK (plan_tier IN ('operate', 'guided', 'managed', 'custom'))
);

CREATE INDEX IF NOT EXISTS user_profiles_email_idx ON user_profiles (email);
CREATE INDEX IF NOT EXISTS user_profiles_legacy_clerk_idx ON user_profiles (legacy_clerk_id)
  WHERE legacy_clerk_id IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('036_better_auth') ON CONFLICT DO NOTHING;
