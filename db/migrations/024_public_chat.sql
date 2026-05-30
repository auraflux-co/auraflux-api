-- CPD-421: public_chat — marketing site + app pre-sales chat sessions and messages
-- Superadmin can review all live and historical conversations via /admin/chat

CREATE TABLE IF NOT EXISTS public_chat_sessions (
  id              TEXT        PRIMARY KEY,           -- nanoid (12 chars)
  origin          TEXT        NOT NULL DEFAULT 'marketing', -- 'marketing' | 'app'
  visitor_ip      TEXT,
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  message_count   INTEGER     NOT NULL DEFAULT 0,
  escalated       BOOLEAN     NOT NULL DEFAULT FALSE, -- visitor requested human
  resolved        BOOLEAN     NOT NULL DEFAULT FALSE,
  last_preview    TEXT                                -- last message snippet
);

CREATE TABLE IF NOT EXISTS public_chat_messages (
  id         SERIAL      PRIMARY KEY,
  session_id TEXT        NOT NULL REFERENCES public_chat_sessions(id) ON DELETE CASCADE,
  role       TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pcs_last_msg ON public_chat_sessions (last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_pcm_session  ON public_chat_messages (session_id, created_at ASC);
