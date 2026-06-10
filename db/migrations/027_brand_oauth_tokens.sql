-- 027_brand_oauth_tokens.sql
-- Add brand_id to platform_oauth_tokens to support brand-specific social connections.
-- Allows multiple YouTube/TikTok/Instagram connections per customer account,
-- one per brand.

-- Add brand_id column (nullable for backward compat with existing single-brand tokens)
ALTER TABLE platform_oauth_tokens
  ADD COLUMN IF NOT EXISTS brand_id UUID;

-- Drop old constraint (customer_id, platform)
ALTER TABLE platform_oauth_tokens
  DROP CONSTRAINT IF EXISTS platform_oauth_tokens_customer_id_platform_key;

-- Add foreign key to brands table
ALTER TABLE platform_oauth_tokens
  ADD CONSTRAINT fk_oauth_tokens_brand
    FOREIGN KEY (brand_id)
    REFERENCES brands(id)
    ON DELETE CASCADE;

-- Add new UNIQUE constraint (customer_id, brand_id, platform)
-- This allows one connection per brand per platform
ALTER TABLE platform_oauth_tokens
  ADD CONSTRAINT platform_oauth_tokens_customer_brand_platform_key
    UNIQUE (customer_id, brand_id, platform);

-- Index for brand_id lookups
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_brand ON platform_oauth_tokens (brand_id);

-- Migrate existing tokens to first brand for each customer
-- (for customers who already have tokens but haven't migrated to multi-brand)
UPDATE platform_oauth_tokens pot
SET brand_id = (
  SELECT b.id
  FROM brands b
  WHERE b.account_id = pot.customer_id
  ORDER BY b.created_at ASC
  LIMIT 1
)
WHERE brand_id IS NULL
  AND EXISTS (SELECT 1 FROM brands WHERE account_id = pot.customer_id);

INSERT INTO schema_migrations (version) VALUES ('027_brand_oauth_tokens') ON CONFLICT DO NOTHING;
