-- 033_voice_webrtc.sql
-- WebRTC agent credentials, presence, and voice call log.

CREATE TABLE IF NOT EXISTS telnyx_webrtc_credentials (
  clerk_user_id   TEXT        PRIMARY KEY,
  credential_id   TEXT        NOT NULL,
  sip_username    TEXT        NOT NULL,
  display_name    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS voice_agent_presence (
  clerk_user_id   TEXT        PRIMARY KEY,
  credential_id   TEXT        NOT NULL,
  sip_username    TEXT        NOT NULL,
  display_name    TEXT,
  status          TEXT        NOT NULL DEFAULT 'online',
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_voice_agent_presence_last_seen
  ON voice_agent_presence (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS voice_call_log (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  call_control_id   TEXT,
  call_session_id   TEXT,
  direction         TEXT        NOT NULL,
  from_number       TEXT,
  to_number         TEXT,
  aura_line         TEXT,
  status            TEXT        NOT NULL DEFAULT 'ringing',
  agent_clerk_id    TEXT,
  slack_user_id     TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at       TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_voice_call_log_started
  ON voice_call_log (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_voice_call_log_status
  ON voice_call_log (status, started_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('033_voice_webrtc')
ON CONFLICT DO NOTHING;
