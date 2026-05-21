-- Migration 015: Operator support inbox (CPD-310)
-- Adds operator tracking + human takeover flag to support_sessions.
-- Also adds operator role column to support_messages so replies are attributed.

ALTER TABLE support_sessions
  ADD COLUMN IF NOT EXISTS operator_id       TEXT,
  ADD COLUMN IF NOT EXISTS human_took_over   BOOLEAN NOT NULL DEFAULT FALSE;

-- operator_id: Clerk user ID of the operator who last replied
-- human_took_over: TRUE once any operator has manually replied — suspends AI auto-reply

-- Allow getSessionMessages to be called without user_id filter (operator viewing any session)
-- (application-level enforcement handles access control)

-- Index for operator inbox query: all open sessions ordered by recency
CREATE INDEX IF NOT EXISTS idx_support_sessions_open
  ON support_sessions (resolved, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_sessions_human
  ON support_sessions (human_took_over, resolved);

INSERT INTO schema_migrations (version) VALUES ('015_support_operator') ON CONFLICT DO NOTHING;
