-- 019_brand_image.sql — Brand logo / image URL (CPD-380)
--
-- Adds image_url and description columns to the brands table so each brand
-- can have a custom logo image and a short display title override.

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS image_url   TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT;

INSERT INTO schema_migrations (version) VALUES ('019_brand_image') ON CONFLICT DO NOTHING;
