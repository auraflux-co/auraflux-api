-- CPD-490: app_content — superadmin-editable UI copy for app pages
-- Hybrid model: JSON defaults baked at build time; DB rows override at runtime.
-- App reads GET /api/admin/app-content (cached); superadmin writes via POST.
-- Reset to default: DELETE the row — app falls back to JSON default automatically.
CREATE TABLE IF NOT EXISTS app_content (
  id          SERIAL PRIMARY KEY,
  page_key    TEXT NOT NULL,   -- e.g. 'myjobs', 'billing', 'generate', 'global'
  key         TEXT NOT NULL,   -- e.g. 'empty_state_title', 'cta_label', 'section_heading'
  value       TEXT NOT NULL,   -- override value
  updated_by  TEXT,            -- Clerk user ID of last editor
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (page_key, key)
);

CREATE INDEX IF NOT EXISTS idx_app_content_page
  ON app_content (page_key);
