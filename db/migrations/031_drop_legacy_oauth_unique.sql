-- 031_drop_legacy_oauth_unique.sql
-- Drop the legacy unique index (customer_id, platform) that was created before
-- multi-brand support. Migration 027 tried to drop it by the wrong name, so it
-- survived and blocked any second YouTube/TikTok/Instagram connection per customer.
-- The correct per-brand constraint platform_oauth_tokens_customer_brand_platform_key
-- (customer_id, brand_id, platform) was already in place from migration 027.

DROP INDEX IF EXISTS idx_oauth_tokens_customer_platform;

INSERT INTO schema_migrations (version)
VALUES ('031_drop_legacy_oauth_unique')
ON CONFLICT DO NOTHING;
