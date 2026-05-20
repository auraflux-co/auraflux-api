-- 014_notifications.sql
-- DB-backed notification system (CPD-307).
-- Replaces the client-side job-status polling approach with server-written
-- rows that persist read state across devices and browsers.

CREATE TABLE IF NOT EXISTS notifications (
  id          SERIAL      PRIMARY KEY,
  customer_id TEXT        NOT NULL,
  type        TEXT        NOT NULL,
  -- type values: job_ready | job_failed | job_held | job_published
  --              credits_low | credits_exhausted | credit_pack_purchased
  --              platform_connected | platform_expired
  --              scheduled_missed | template_failed
  --              operator_note | support_resolved
  title       TEXT        NOT NULL,
  body        TEXT,
  action_url  TEXT,
  read        BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_customer
  ON notifications (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (customer_id, read)
  WHERE read = FALSE;

INSERT INTO schema_migrations (version) VALUES ('014_notifications') ON CONFLICT DO NOTHING;
