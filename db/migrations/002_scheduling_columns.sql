-- 002_scheduling_columns.sql
-- Adds scheduled publish columns to jobs table (CPD-48).
-- publish_mode:          'immediate' | 'scheduled'
-- scheduled_publish_at:  epoch ms — when to auto-publish
-- actual_published_at:   epoch ms — when actually published (marks job done)

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS publish_mode          TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS scheduled_publish_at  BIGINT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS actual_published_at   BIGINT;

CREATE INDEX IF NOT EXISTS idx_jobs_scheduled ON jobs(scheduled_publish_at)
  WHERE publish_mode = 'scheduled' AND actual_published_at IS NULL;

INSERT INTO schema_migrations (version) VALUES ('002_scheduling_columns')
  ON CONFLICT (version) DO NOTHING;
