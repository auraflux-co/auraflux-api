-- YouTube/Twitch VOD peaks + staged windows for customer Peaks → compose flow

CREATE TABLE IF NOT EXISTS library_vod_sessions (
  id           BIGSERIAL PRIMARY KEY,
  platform     TEXT NOT NULL,
  streamer     TEXT NOT NULL DEFAULT 'unknown',
  vod_id       TEXT NOT NULL,
  url          TEXT,
  title        TEXT,
  duration_sec INT DEFAULT 0,
  views        INT DEFAULT 0,
  status       TEXT DEFAULT 'pending',
  brand_id     UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (platform, vod_id)
);

CREATE TABLE IF NOT EXISTS library_vod_segments (
  id         BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES library_vod_sessions(id) ON DELETE CASCADE,
  start_sec  DOUBLE PRECISION NOT NULL,
  end_sec    DOUBLE PRECISION NOT NULL,
  score      DOUBLE PRECISION,
  title      TEXT,
  summary    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS library_vod_segments_session_idx
  ON library_vod_segments (session_id, score DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS library_staged_clips (
  id            BIGSERIAL PRIMARY KEY,
  platform      TEXT NOT NULL,
  streamer      TEXT NOT NULL DEFAULT 'unknown',
  clip_id       TEXT NOT NULL,
  url           TEXT,
  title         TEXT,
  duration_sec  INT DEFAULT 0,
  thumbnail_url TEXT,
  r2_key        TEXT,
  r2_url        TEXT,
  staged_at     BIGINT,
  used_at       BIGINT,
  job_id        TEXT,
  expires_at    BIGINT,
  status        TEXT DEFAULT 'ready',
  error         TEXT,
  brand_id      UUID,
  UNIQUE (platform, clip_id)
);

CREATE INDEX IF NOT EXISTS library_staged_clips_url_idx
  ON library_staged_clips (url);

INSERT INTO schema_migrations (version) VALUES ('040_content_library_peaks')
  ON CONFLICT DO NOTHING;
