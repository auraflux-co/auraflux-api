-- 017_brands.sql — Multi-brand accounts (CPD-328)
--
-- Adds a `brands` table so a single AuraFlux account can own multiple brand
-- subscriptions. Each brand gets its own client_plans row (and therefore its
-- own credits, tier, and Stripe subscription).
--
-- Backward-compat: all new columns are nullable. Existing rows are backfilled
-- so that every current customer ends up with exactly 1 brand called
-- "Main Brand". All existing behaviour is unchanged — `client_id` lookups
-- continue to work via the legacy path in postgres.js.

-- ── 1. Brands table ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS brands (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  TEXT        NOT NULL,    -- Clerk userId (account owner)
  name        TEXT        NOT NULL DEFAULT 'Main Brand',
  slug        TEXT,                    -- URL-safe name, set on creation
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  active      BOOLEAN     DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_brands_account ON brands(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_brands_account_slug ON brands(account_id, slug)
  WHERE slug IS NOT NULL;

-- ── 2. Add brand_id + account_id to client_plans ──────────────────────────────

ALTER TABLE client_plans
  ADD COLUMN IF NOT EXISTS brand_id   UUID REFERENCES brands(id),
  ADD COLUMN IF NOT EXISTS account_id TEXT;  -- owner Clerk userId (may differ from client_id for team members)

-- ── 3. Backfill: create 1 brand per existing client_plans row ─────────────────

-- Insert a brand for each unique client_id (idempotent via ON CONFLICT DO NOTHING
-- on the unique account_id+slug index — use a temp approach without a unique key
-- on just account_id since multiple brands per account are allowed).
-- We use a CTE to avoid inserting duplicates if migration is re-run.
WITH new_brands AS (
  INSERT INTO brands (account_id, name, slug)
  SELECT DISTINCT
    cp.client_id,
    'Main Brand',
    'main-brand'
  FROM client_plans cp
  WHERE NOT EXISTS (
    SELECT 1 FROM brands b WHERE b.account_id = cp.client_id
  )
  RETURNING id, account_id
)
UPDATE client_plans cp
SET
  brand_id   = nb.id,
  account_id = nb.account_id
FROM new_brands nb
WHERE cp.client_id = nb.account_id
  AND cp.brand_id IS NULL;

-- Handle case where brands already existed (re-run safety)
UPDATE client_plans cp
SET
  brand_id   = b.id,
  account_id = b.account_id
FROM brands b
WHERE b.account_id = cp.client_id
  AND cp.brand_id IS NULL;

-- ── 4. Add brand_id to jobs (nullable — old jobs stay NULL) ───────────────────

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES brands(id);

CREATE INDEX IF NOT EXISTS idx_jobs_brand_id ON jobs(brand_id)
  WHERE brand_id IS NOT NULL;

-- ── 5. Add brand_id to platform_oauth_tokens ─────────────────────────────────

ALTER TABLE platform_oauth_tokens
  ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES brands(id);

-- Backfill: match customer_id → account_id → brand id
UPDATE platform_oauth_tokens pot
SET brand_id = b.id
FROM brands b
WHERE b.account_id = pot.customer_id
  AND pot.brand_id IS NULL;

-- New partial unique index: (brand_id, platform) — allows multiple brands
-- to each have their own OAuth token per platform.
-- The old (customer_id, platform) unique constraint is kept for compat with
-- legacy rows that have no brand_id yet.
CREATE UNIQUE INDEX IF NOT EXISTS idx_oauth_brand_platform
  ON platform_oauth_tokens(brand_id, platform)
  WHERE brand_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_oauth_brand_id
  ON platform_oauth_tokens(brand_id)
  WHERE brand_id IS NOT NULL;

-- ── Migration record ──────────────────────────────────────────────────────────

INSERT INTO schema_migrations (version) VALUES ('017_brands') ON CONFLICT DO NOTHING;
