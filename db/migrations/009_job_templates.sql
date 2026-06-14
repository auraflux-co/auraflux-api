-- Migration 009 — Job templates (CPD-116 / CPD-119)
-- job_templates: per-customer reusable job spec snapshots with optional recurrence.

CREATE TABLE IF NOT EXISTS job_templates (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     VARCHAR(255)  NOT NULL,
  name            VARCHAR(255)  NOT NULL,
  description     TEXT,
  content_type    VARCHAR(100),
  platforms       TEXT[]        DEFAULT '{}',
  job_spec        JSONB         NOT NULL,
  -- Recurrence config (CPD-119)
  recurrence_type VARCHAR(20)   CHECK (recurrence_type IN ('once','daily','weekly','monthly')),
  recurrence_day  SMALLINT,     -- 0=Sun…6=Sat for weekly; 1-28 for monthly
  recurrence_time VARCHAR(5),   -- HH:MM UTC e.g. '15:00'
  recurrence_active BOOLEAN     DEFAULT FALSE,
  last_fired_at   TIMESTAMPTZ,
  next_fire_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_templates_customer ON job_templates (customer_id);
CREATE INDEX IF NOT EXISTS idx_job_templates_next_fire ON job_templates (next_fire_at)
  WHERE recurrence_active = TRUE AND next_fire_at IS NOT NULL;

-- Scheduled start column on jobs (CPD-118)
-- Distinct from scheduled_publish_at (deferred publish).
-- scheduled_start_at = when to begin the production pipeline.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS scheduled_start_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_jobs_scheduled_start ON jobs (scheduled_start_at)
  WHERE scheduled_start_at IS NOT NULL AND status = 'queued_scheduled';

INSERT INTO schema_migrations (version) VALUES ('009_job_templates') ON CONFLICT DO NOTHING;
