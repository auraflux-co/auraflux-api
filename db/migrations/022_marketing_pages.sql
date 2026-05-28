-- CPD-402: marketing_pages — superadmin-editable content for auraflux.co pages
-- Worker reads from GET /api/admin/marketing/content (public, 5-min cache)
-- Superadmin writes via POST /api/admin/marketing/pages (superadmin auth)
CREATE TABLE IF NOT EXISTS marketing_pages (
  id          SERIAL PRIMARY KEY,
  page_key    TEXT NOT NULL,   -- e.g. 'pricing', 'homepage', 'contact'
  section_key TEXT NOT NULL,   -- e.g. 'hero_headline', 'cta_text', 'faq_1'
  content     TEXT NOT NULL,
  updated_by  TEXT,            -- Clerk user ID of last editor
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (page_key, section_key)
);

CREATE INDEX IF NOT EXISTS idx_marketing_pages_key
  ON marketing_pages (page_key);
