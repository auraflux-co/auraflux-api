-- 030_brand_telnyx_numbers.sql
-- Adds Telnyx phone number assignment per brand + inbox for inbound SMS
-- (verification codes from TikTok, Instagram, etc.)
--
-- brands.telnyx_number   — E.164 number provisioned from Telnyx for this brand
-- brand_sms_inbox        — last N inbound SMS per number (used for 2FA code display)

-- ── brands.telnyx_number ──────────────────────────────────────────────────
ALTER TABLE brands
  ADD COLUMN IF NOT EXISTS telnyx_number TEXT;

-- Only one brand may use a given Telnyx number
CREATE UNIQUE INDEX IF NOT EXISTS idx_brands_telnyx_number
  ON brands (telnyx_number)
  WHERE telnyx_number IS NOT NULL;

-- ── brand_sms_inbox ───────────────────────────────────────────────────────
-- Stores inbound SMS messages received on brand Telnyx numbers.
-- Primarily used to surface social platform verification codes in the UI.
CREATE TABLE IF NOT EXISTS brand_sms_inbox (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id    UUID        NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  from_number TEXT        NOT NULL,
  to_number   TEXT        NOT NULL,
  body        TEXT        NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_brand_sms_inbox_brand
  ON brand_sms_inbox (brand_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_brand_sms_inbox_to_number
  ON brand_sms_inbox (to_number, received_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('030_brand_telnyx_numbers')
ON CONFLICT DO NOTHING;
