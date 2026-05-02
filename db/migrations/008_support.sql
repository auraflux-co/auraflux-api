-- Migration 008: Support sessions and messages
-- Stores AuraFlux support chat history (web + SMS channels)

CREATE TABLE IF NOT EXISTS support_sessions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT        NOT NULL,
  phone_number     TEXT,                          -- E.164 format, set when SMS thread attached
  created_at       BIGINT      NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  resolved         BOOLEAN     NOT NULL DEFAULT FALSE,
  escalated        BOOLEAN     NOT NULL DEFAULT FALSE,
  escalation_channel TEXT                         -- 'sms' | 'email' | null
);

CREATE INDEX IF NOT EXISTS idx_support_sessions_user_id ON support_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_support_sessions_phone   ON support_sessions (phone_number);

CREATE TABLE IF NOT EXISTS support_messages (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID    NOT NULL REFERENCES support_sessions(id) ON DELETE CASCADE,
  user_id      TEXT    NOT NULL,
  role         TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
  content      TEXT    NOT NULL,
  channel      TEXT    NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'sms')),
  created_at   BIGINT  NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_support_messages_session ON support_messages (session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_support_messages_user    ON support_messages (user_id);

INSERT INTO schema_migrations (version) VALUES ('008_support') ON CONFLICT DO NOTHING;
