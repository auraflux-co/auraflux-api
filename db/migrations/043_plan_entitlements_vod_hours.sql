-- Plan entitlements: VOD hours, channel caps, queue priority, export profile
-- Growth ($299) vs Operate/Pro ($999) vs Guided/Managed

ALTER TABLE client_plans
  ADD COLUMN IF NOT EXISTS vod_hours_included NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS max_channels INTEGER,
  ADD COLUMN IF NOT EXISTS queue_priority INTEGER DEFAULT 10,
  ADD COLUMN IF NOT EXISTS export_vertical_w INTEGER DEFAULT 1080,
  ADD COLUMN IF NOT EXISTS export_vertical_h INTEGER DEFAULT 1920,
  ADD COLUMN IF NOT EXISTS export_fps INTEGER DEFAULT 60,
  ADD COLUMN IF NOT EXISTS has_account_manager BOOLEAN DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS vod_hours_ledger (
  id            BIGSERIAL PRIMARY KEY,
  client_id     TEXT NOT NULL,
  brand_id      UUID,
  job_id        TEXT,
  hours_delta   NUMERIC(12,4) NOT NULL,
  reason        TEXT,
  period_start  TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vod_hours_ledger_client_period
  ON vod_hours_ledger (client_id, period_start);

CREATE TABLE IF NOT EXISTS brand_caption_fonts (
  id            BIGSERIAL PRIMARY KEY,
  brand_id      UUID NOT NULL,
  account_id    TEXT NOT NULL,
  font_name     TEXT NOT NULL,
  r2_key        TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brand_caption_fonts_brand
  ON brand_caption_fonts (brand_id);

ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS caption_font_key TEXT,
  ADD COLUMN IF NOT EXISTS caption_font_url TEXT;
