-- 032_slack_sms_threads.sql
-- Maps Slack thread → Telnyx SMS session for reply-in-thread flow.

CREATE TABLE IF NOT EXISTS slack_sms_threads (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_channel   TEXT        NOT NULL,
  slack_thread_ts TEXT        NOT NULL,
  from_number     TEXT        NOT NULL,
  to_number       TEXT        NOT NULL,
  brand_name      TEXT,
  last_inbound    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (slack_channel, slack_thread_ts)
);

CREATE INDEX IF NOT EXISTS idx_slack_sms_threads_lookup
  ON slack_sms_threads (slack_channel, slack_thread_ts);

INSERT INTO schema_migrations (version)
VALUES ('032_slack_sms_threads')
ON CONFLICT DO NOTHING;
