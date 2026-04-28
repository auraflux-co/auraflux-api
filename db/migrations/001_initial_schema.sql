-- AuraFlux C1+ PostgreSQL Schema
-- Migrated from lib/db.js SQLite schema.
-- Run via: psql $DATABASE_URL -f db/migrations/001_initial_schema.sql
-- Or via scripts/migrate_sqlite_to_pg.js (preferred for Render).

-- ── Jobs ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT        PRIMARY KEY,
  content_type TEXT        NOT NULL,
  form_type    TEXT,
  status       TEXT        DEFAULT 'pending',
  stage        TEXT        DEFAULT 'script_ready',
  job_spec     JSONB,
  customer_id  TEXT,
  template_id  TEXT,
  failed_gate  INTEGER,
  root_cause   TEXT,
  restart_gate INTEGER,
  script_job_id TEXT,
  drive_url    TEXT,
  published_at BIGINT,
  created_at   BIGINT      NOT NULL,
  updated_at   BIGINT      NOT NULL,
  card         JSONB       NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status        ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_stage         ON jobs(stage);
CREATE INDEX IF NOT EXISTS idx_jobs_created       ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_script_job_id ON jobs(script_job_id);
CREATE INDEX IF NOT EXISTS idx_jobs_customer_id   ON jobs(customer_id);

-- ── Job Metrics ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_metrics (
  id          BIGSERIAL   PRIMARY KEY,
  job_id      TEXT        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stage       TEXT        NOT NULL,
  duration_ms INTEGER,
  data        JSONB,
  created_at  BIGINT      NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_job_metrics_job ON job_metrics(job_id);

-- ── Gate Fixes ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gate_fixes (
  id           BIGSERIAL   PRIMARY KEY,
  job_id       TEXT        NOT NULL,
  gate         INTEGER     NOT NULL,
  score_before INTEGER,
  score_after  INTEGER,
  action       TEXT,
  reason       TEXT,
  created_at   BIGINT      NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gate_fixes_job ON gate_fixes(job_id);

-- ── Gate Results ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gate_results (
  id         BIGSERIAL   PRIMARY KEY,
  job_id     TEXT        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  gate       TEXT        NOT NULL,
  passed     SMALLINT    NOT NULL,
  score      INTEGER,
  result     JSONB       NOT NULL,
  created_at BIGINT      NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gate_results_job ON gate_results(job_id);

-- ── Publish Results ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS publish_results (
  id              BIGSERIAL   PRIMARY KEY,
  job_id          TEXT        NOT NULL,
  platform        TEXT        NOT NULL,
  platform_job_id TEXT,
  drive_url       TEXT,
  title           TEXT,
  status          TEXT        DEFAULT 'pending',
  published_at    BIGINT,
  created_at      BIGINT      NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_publish_job    ON publish_results(job_id);
CREATE INDEX IF NOT EXISTS idx_publish_status ON publish_results(status);

-- ── Assembly Jobs ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS assembly_jobs (
  id             TEXT        PRIMARY KEY,
  job_id         TEXT        NOT NULL,
  content_type   TEXT,
  format         TEXT        DEFAULT 'mp4',
  status         TEXT        DEFAULT 'assembling',
  out_path       TEXT,
  drive_url      TEXT,
  gate2_score    INTEGER,
  gate3a_score   INTEGER,
  gate3b_outcome TEXT,
  gate4_score    INTEGER,
  started_at     BIGINT      NOT NULL,
  completed_at   BIGINT,
  created_at     BIGINT      NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_asm_job_id ON assembly_jobs(job_id);
CREATE INDEX IF NOT EXISTS idx_asm_status ON assembly_jobs(status);

-- ── HeyGen Renders (C0 legacy — kept for migration completeness) ──────────────

CREATE TABLE IF NOT EXISTS heygen_renders (
  id             BIGSERIAL   PRIMARY KEY,
  job_id         TEXT        NOT NULL,
  video_id       TEXT        UNIQUE,
  scene_name     TEXT,
  status         TEXT        DEFAULT 'pending',
  render_time_ms INTEGER,
  video_url      TEXT,
  created_at     BIGINT      NOT NULL,
  completed_at   BIGINT
);

CREATE INDEX IF NOT EXISTS idx_heygen_job_id   ON heygen_renders(job_id);
CREATE INDEX IF NOT EXISTS idx_heygen_video_id ON heygen_renders(video_id);

-- ── Why Ledger ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS why_ledger (
  id                      BIGSERIAL   PRIMARY KEY,
  job_id                  TEXT        NOT NULL,
  gate                    TEXT,
  kind                    TEXT        NOT NULL,
  passed                  SMALLINT,
  score                   INTEGER,
  outcome                 TEXT,
  failure_class           TEXT,
  intervention_type       TEXT,
  intervention_outcome    TEXT,
  reasons_json            JSONB,
  contract_digest_json    JSONB,
  evidence_digest_json    JSONB,
  source                  TEXT,
  meta_json               JSONB,
  created_at              BIGINT      NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_why_ledger_job     ON why_ledger(job_id);
CREATE INDEX IF NOT EXISTS idx_why_ledger_created ON why_ledger(created_at DESC);

-- ── Schema Migrations Tracker ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT        PRIMARY KEY,
  applied_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO schema_migrations (version) VALUES ('001_initial_schema')
  ON CONFLICT (version) DO NOTHING;
