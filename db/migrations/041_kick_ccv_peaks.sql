-- Customer-scoped Kick CCV capture (official Kick Dev API — no Apify)
-- Poll live viewer_count while stream is on; peak + integer ?t= VOD deeplink.

CREATE TABLE IF NOT EXISTS kick_ccv_streams (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id        UUID,
  customer_id     TEXT,
  kick_slug       TEXT NOT NULL,
  kick_user_id    TEXT,
  kick_stream_id  TEXT,
  title           TEXT,
  category_name   TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ,
  peak_viewers    INT NOT NULL DEFAULT 0,
  peak_at         TIMESTAMPTZ,
  peak_offset_sec INT,
  avg_viewers     NUMERIC(12, 2),
  sample_count    INT NOT NULL DEFAULT 0,
  vod_id          TEXT,
  vod_url         TEXT,
  status          TEXT NOT NULL DEFAULT 'live'
                  CHECK (status IN ('live', 'ended', 'linked')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS kick_ccv_streams_live_slug_uidx
  ON kick_ccv_streams (kick_slug)
  WHERE status = 'live';

CREATE INDEX IF NOT EXISTS kick_ccv_streams_brand_idx
  ON kick_ccv_streams (brand_id, started_at DESC);

CREATE INDEX IF NOT EXISTS kick_ccv_streams_slug_idx
  ON kick_ccv_streams (kick_slug, started_at DESC);

CREATE TABLE IF NOT EXISTS kick_ccv_samples (
  id           BIGSERIAL PRIMARY KEY,
  stream_id    UUID NOT NULL REFERENCES kick_ccv_streams(id) ON DELETE CASCADE,
  sampled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  viewer_count INT NOT NULL DEFAULT 0,
  offset_sec   INT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS kick_ccv_samples_stream_idx
  ON kick_ccv_samples (stream_id, sampled_at);

INSERT INTO schema_migrations (version) VALUES ('041_kick_ccv_peaks')
  ON CONFLICT DO NOTHING;
