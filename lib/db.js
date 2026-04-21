'use strict';
// lib/db.js — SQLite persistence layer for AuraFlux job cards, specs, metrics, and gate data.
// Runs ALONGSIDE data/jobs.json during transition — does not replace it.

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'cwn.db');

let _db = null;

// ── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT    PRIMARY KEY,
    content_type TEXT    NOT NULL,
    form_type    TEXT,
    status       TEXT    DEFAULT 'pending',
    stage        TEXT    DEFAULT 'script_ready',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    card         JSON    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_stage   ON jobs(stage);
  CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);

  CREATE TABLE IF NOT EXISTS job_metrics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT    NOT NULL REFERENCES jobs(id),
    stage       TEXT    NOT NULL,
    duration_ms INTEGER,
    data        JSON,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS gate_fixes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT    NOT NULL,
    gate         INTEGER NOT NULL,
    score_before INTEGER,
    score_after  INTEGER,
    action       TEXT,
    reason       TEXT,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS gate_results (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id     TEXT    NOT NULL REFERENCES jobs(id),
    gate       TEXT    NOT NULL,
    passed     INTEGER NOT NULL,
    score      INTEGER,
    result     JSON    NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_gate_results_job ON gate_results(job_id);

  CREATE TABLE IF NOT EXISTS publish_results (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT    NOT NULL,
    platform     TEXT    NOT NULL,
    platform_job_id TEXT,
    drive_url    TEXT,
    title        TEXT,
    status       TEXT    DEFAULT 'pending',
    published_at INTEGER,
    created_at   INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_publish_job    ON publish_results(job_id);
  CREATE INDEX IF NOT EXISTS idx_publish_status ON publish_results(status);

  CREATE TABLE IF NOT EXISTS assembly_jobs (
    id           TEXT PRIMARY KEY,
    job_id       TEXT NOT NULL,
    content_type TEXT,
    format       TEXT DEFAULT 'mp4',
    status       TEXT DEFAULT 'assembling',
    out_path     TEXT,
    drive_url    TEXT,
    gate2_score  INTEGER,
    gate3a_score INTEGER,
    gate3b_outcome TEXT,
    gate4_score  INTEGER,
    started_at   INTEGER NOT NULL,
    completed_at INTEGER,
    created_at   INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_asm_job_id ON assembly_jobs(job_id);
  CREATE INDEX IF NOT EXISTS idx_asm_status ON assembly_jobs(status);

  CREATE TABLE IF NOT EXISTS heygen_renders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT NOT NULL,
    video_id     TEXT UNIQUE,
    scene_name   TEXT,
    status       TEXT DEFAULT 'pending',
    render_time_ms INTEGER,
    video_url    TEXT,
    created_at   INTEGER NOT NULL,
    completed_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_heygen_job_id  ON heygen_renders(job_id);
  CREATE INDEX IF NOT EXISTS idx_heygen_video_id ON heygen_renders(video_id);

  CREATE TABLE IF NOT EXISTS why_ledger (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id                  TEXT    NOT NULL,
    gate                    TEXT,
    kind                    TEXT    NOT NULL,
    passed                  INTEGER,
    score                   INTEGER,
    outcome                 TEXT,
    failure_class           TEXT,
    intervention_type       TEXT,
    intervention_outcome    TEXT,
    reasons_json            TEXT,
    contract_digest_json    TEXT,
    evidence_digest_json    TEXT,
    source                  TEXT,
    meta_json               TEXT,
    created_at              INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_why_ledger_job ON why_ledger(job_id);
  CREATE INDEX IF NOT EXISTS idx_why_ledger_created ON why_ledger(created_at);
`;

// ── Init ─────────────────────────────────────────────────────────────────────

function initDb() {
  if (_db) return _db;

  // Ensure data/ directory exists
  const dataDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');   // Safe for concurrent readers
  _db.pragma('foreign_keys = ON');

  // Run all CREATE TABLE / INDEX statements
  _db.exec(SCHEMA);

  // Migration: add new columns to existing jobs table if not present
  _migrateJobsTable(_db);

  console.log(`[db] SQLite opened: ${DB_PATH}`);
  return _db;
}

/**
 * Add new columns to the jobs table if they don't already exist.
 * Uses PRAGMA table_info to check column existence — migration-safe.
 */
function _migrateJobsTable(db) {
  const existingColumns = db.pragma('table_info(jobs)').map(c => c.name);

  const newColumns = [
    { name: 'job_spec',      ddl: 'ALTER TABLE jobs ADD COLUMN job_spec JSON' },
    { name: 'customer_id',   ddl: 'ALTER TABLE jobs ADD COLUMN customer_id TEXT' },
    { name: 'template_id',   ddl: 'ALTER TABLE jobs ADD COLUMN template_id TEXT' },
    { name: 'failed_gate',   ddl: 'ALTER TABLE jobs ADD COLUMN failed_gate INTEGER' },
    { name: 'root_cause',    ddl: 'ALTER TABLE jobs ADD COLUMN root_cause TEXT' },
    { name: 'restart_gate',  ddl: 'ALTER TABLE jobs ADD COLUMN restart_gate INTEGER' },
    { name: 'script_job_id', ddl: 'ALTER TABLE jobs ADD COLUMN script_job_id TEXT' },
    { name: 'drive_url',     ddl: 'ALTER TABLE jobs ADD COLUMN drive_url TEXT' },
    { name: 'published_at',  ddl: 'ALTER TABLE jobs ADD COLUMN published_at INTEGER' },
  ];

  // Add script_job_id index if not exists (migration-safe)
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_jobs_script_job_id ON jobs(script_job_id)');
  } catch(e) { /* already exists */ }

  for (const col of newColumns) {
    if (!existingColumns.includes(col.name)) {
      try {
        db.exec(col.ddl);
        console.log(`[db] Migration: added column jobs.${col.name}`);
      } catch (e) {
        // Column may have been added by a concurrent process — log and continue
        console.warn(`[db] Migration warning for jobs.${col.name}: ${e.message}`);
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getDb() {
  if (!_db) initDb();
  return _db;
}

// ── Job CRUD ──────────────────────────────────────────────────────────────────

/**
 * Upsert a job card into SQLite.
 * Extracts indexed scalar fields from card; full card stored as JSON.
 */
function saveJob(jobId, card) {
  const db  = getDb();
  const now = Date.now();

  const contentType = card.contentType || card.content_type || '';
  const formType    = card.formType    || card.form_type    || null;
  const status      = card.status      || 'pending';
  const stage       = card.stage       || 'script_ready';

  // created_at: use card timestamp if available, else now
  const createdAt = card.createdAt
    ? new Date(card.createdAt).getTime()
    : (card.savedAt ? new Date(card.savedAt).getTime() : now);

  const stmt = db.prepare(`
    INSERT INTO jobs (id, content_type, form_type, status, stage, created_at, updated_at, card)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content_type = excluded.content_type,
      form_type    = excluded.form_type,
      status       = excluded.status,
      stage        = excluded.stage,
      updated_at   = excluded.updated_at,
      card         = excluded.card
  `);

  stmt.run(
    jobId,
    contentType,
    formType,
    status,
    stage,
    createdAt,
    now,
    JSON.stringify(card)
  );
}

/**
 * Load a single job card by ID. Returns parsed card object or null.
 */
function loadJob(jobId) {
  const db  = getDb();
  const row = db.prepare('SELECT card FROM jobs WHERE id = ?').get(jobId);
  if (!row) return null;
  try {
    return JSON.parse(row.card);
  } catch (e) {
    console.error(`[db] Failed to parse card for job ${jobId}:`, e.message);
    return null;
  }
}

/**
 * Load all jobs ordered by created_at desc, max 200.
 * Returns array of parsed card objects.
 */
function loadAllJobs() {
  const db   = getDb();
  const rows = db.prepare('SELECT card FROM jobs ORDER BY created_at DESC LIMIT 200').all();
  return rows.map(row => {
    try {
      return JSON.parse(row.card);
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Delete jobs older than daysOld days.
 */
function deleteOldJobs(daysOld = 7) {
  const db     = getDb();
  const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
  const result = db.prepare('DELETE FROM jobs WHERE created_at < ?').run(cutoff);
  if (result.changes > 0) {
    console.log(`[db] Pruned ${result.changes} jobs older than ${daysOld} days`);
  }
  return result.changes;
}

// ── Metrics ───────────────────────────────────────────────────────────────────

/**
 * Insert a row into job_metrics.
 */
function saveMetric(jobId, stage, durationMs, data) {
  const db = getDb();
  db.prepare(`
    INSERT INTO job_metrics (job_id, stage, duration_ms, data, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    jobId,
    stage,
    durationMs   ?? null,
    data ? JSON.stringify(data) : null,
    Date.now()
  );
}

// ── Gate Fixes ────────────────────────────────────────────────────────────────

/**
 * Record a gate fix event (force advance, rollback, etc.)
 */
function saveGateFix(jobId, gate, scoreBefore, scoreAfter, action, reason) {
  const db = getDb();
  db.prepare(`
    INSERT INTO gate_fixes (job_id, gate, score_before, score_after, action, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    jobId,
    gate,
    scoreBefore ?? null,
    scoreAfter  ?? null,
    action      ?? null,
    reason      ?? null,
    Date.now()
  );
}

/**
 * Append-only RCA / intervention row (mirrors NR PipelineWhy + pipeline_events why:ledger).
 */
function saveWhyLedger(row) {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO why_ledger (
      job_id, gate, kind, passed, score, outcome,
      failure_class, intervention_type, intervention_outcome,
      reasons_json, contract_digest_json, evidence_digest_json, source, meta_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.jobId,
    row.gate ?? null,
    row.kind,
    row.passed === null || row.passed === undefined ? null : row.passed ? 1 : 0,
    row.score ?? null,
    row.outcome ?? null,
    row.failureClass ?? null,
    row.interventionType ?? null,
    row.interventionOutcome ?? null,
    row.reasons ? JSON.stringify(row.reasons) : null,
    row.contractDigest ? JSON.stringify(row.contractDigest) : null,
    row.evidenceDigest ? JSON.stringify(row.evidenceDigest) : null,
    row.source ?? null,
    row.meta ? JSON.stringify(row.meta) : null,
    now
  );
}

// ── Job Spec CRUD ─────────────────────────────────────────────────────────────

/**
 * Save (upsert) a full Job Spec JSON into the job_spec column.
 * Also syncs customer_id and template_id scalar columns.
 */
function updateJobSpec(jobId, jobSpec) {
  const db  = getDb();
  const now = Date.now();

  db.prepare(`
    UPDATE jobs
    SET job_spec    = ?,
        customer_id = ?,
        template_id = ?,
        updated_at  = ?
    WHERE id = ?
  `).run(
    JSON.stringify(jobSpec),
    jobSpec.customerId  || null,
    jobSpec.templateId  || null,
    now,
    jobId
  );
}

/**
 * Return a job row with the job_spec column parsed.
 * Returns null if not found.
 */
function getJobBySpec(jobId) {
  const db  = getDb();
  // Try direct ID match first (semantic job ID e.g. c0_COMPACT_FETCH_news_...)
  let row = db.prepare('SELECT job_spec FROM jobs WHERE id = ?').get(jobId);
  // If not found, try indexed script_job_id column (fast)
  if (!row || !row.job_spec) {
    row = db.prepare('SELECT job_spec FROM jobs WHERE script_job_id = ? LIMIT 1').get(jobId);
  }
  // Last resort: json_extract search (slower but catches old records)
  if (!row || !row.job_spec) {
    row = db.prepare(
      "SELECT job_spec FROM jobs WHERE job_spec IS NOT NULL AND json_extract(job_spec, '$.scriptJobId') = ? LIMIT 1"
    ).get(jobId);
  }
  if (!row || !row.job_spec) return null;
  try {
    return JSON.parse(row.job_spec);
  } catch (e) {
    console.error(`[db] Failed to parse job_spec for job ${jobId}:`, e.message);
    return null;
  }
}

// ── Gate Results ──────────────────────────────────────────────────────────────

/**
 * Insert a gate result row into gate_results.
 * result object must have at minimum: { passed: boolean, score?: number, ... }
 */
function saveGateResult(jobId, gate, result) {
  const db = getDb();
  db.prepare(`
    INSERT INTO gate_results (job_id, gate, passed, score, result, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    jobId,
    gate,
    result.passed ? 1 : 0,
    result.score  !== undefined ? result.score : null,
    JSON.stringify(result),
    Date.now()
  );
}

/**
 * Return all gate results for a job, keyed by gate name.
 * e.g. { gate0: {...}, gate1: {...} }
 */
function getGateResults(jobId) {
  const db   = getDb();
  const rows = db.prepare(
    'SELECT gate, result FROM gate_results WHERE job_id = ? ORDER BY id ASC'
  ).all(jobId);

  const out = {};
  for (const row of rows) {
    try {
      out[row.gate] = JSON.parse(row.result);
    } catch (e) {
      out[row.gate] = null;
    }
  }
  return out;
}

// ── Publish Results ───────────────────────────────────────────────────────────

/**
 * Save a Gate 5 publish result per platform.
 */
function savePublishResult(jobId, platform, { platformJobId, driveUrl, title, status }) {
  const db = getDb();
  db.prepare(`
    INSERT INTO publish_results (job_id, platform, platform_job_id, drive_url, title, status, published_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(jobId, platform, platformJobId || null, driveUrl || null, title || null, status || 'pending',
    status === 'published' ? Date.now() : null, Date.now());
}

/**
 * Update drive_url and published_at on the jobs table when a job is published.
 */
function markJobPublished(jobId, driveUrl) {
  const db = getDb();
  db.prepare('UPDATE jobs SET drive_url = ?, published_at = ?, status = ? WHERE id = ?')
    .run(driveUrl || null, Date.now(), 'published', jobId);
}

// ── Assembly Jobs ─────────────────────────────────────────────────────────────

/**
 * Upsert an assembly job row into assembly_jobs.
 * data fields: contentType, format, status, outPath, driveUrl,
 *              gate2Score, gate3aScore, gate3bOutcome, gate4Score,
 *              startedAt, completedAt
 */
function saveAssemblyJob(asmId, jobId, data = {}) {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO assembly_jobs (id, job_id, content_type, format, status, out_path, drive_url,
      gate2_score, gate3a_score, gate3b_outcome, gate4_score, started_at, completed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status         = excluded.status,
      out_path       = COALESCE(excluded.out_path,       out_path),
      drive_url      = COALESCE(excluded.drive_url,      drive_url),
      gate2_score    = COALESCE(excluded.gate2_score,    gate2_score),
      gate3a_score   = COALESCE(excluded.gate3a_score,   gate3a_score),
      gate3b_outcome = COALESCE(excluded.gate3b_outcome, gate3b_outcome),
      gate4_score    = COALESCE(excluded.gate4_score,    gate4_score),
      completed_at   = COALESCE(excluded.completed_at,   completed_at)
  `).run(
    asmId, jobId,
    data.contentType   || null,
    data.format        || 'mp4',
    data.status        || 'assembling',
    data.outPath       || null,
    data.driveUrl      || null,
    data.gate2Score    ?? null,
    data.gate3aScore   ?? null,
    data.gate3bOutcome || null,
    data.gate4Score    ?? null,
    data.startedAt     || now,
    data.completedAt   || null,
    now
  );
}

/**
 * Fetch a single assembly job row by asmId.
 */
function getAssemblyJob(asmId) {
  const db = getDb();
  return db.prepare('SELECT * FROM assembly_jobs WHERE id = ?').get(asmId);
}

// ── HeyGen Renders ────────────────────────────────────────────────────────────

/**
 * Upsert a HeyGen render row. video_id is the unique key.
 * data fields: renderTimeMs, videoUrl
 */
function saveHeyGenRender(jobId, videoId, sceneName, status, data = {}) {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO heygen_renders (job_id, video_id, scene_name, status, render_time_ms, video_url, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id) DO UPDATE SET
      status         = excluded.status,
      render_time_ms = COALESCE(excluded.render_time_ms, render_time_ms),
      video_url      = COALESCE(excluded.video_url,      video_url),
      completed_at   = COALESCE(excluded.completed_at,   completed_at)
  `).run(
    jobId, videoId, sceneName, status,
    data.renderTimeMs || null,
    data.videoUrl     || null,
    now,
    status === 'completed' ? now : null
  );
}

/**
 * Return all HeyGen render rows for a job, ordered by id.
 */
function getHeyGenRenders(jobId) {
  const db = getDb();
  return db.prepare('SELECT * FROM heygen_renders WHERE job_id = ? ORDER BY id').all(jobId);
}

// ── Delete Job ────────────────────────────────────────────────────────────────

/**
 * Delete a job and all its gate results from the DB.
 * Called by DELETE /job/:id so dashboard clear removes from DB too.
 */
function deleteJob(jobId) {
  const db = getDb();
  db.prepare('DELETE FROM why_ledger WHERE job_id = ?').run(jobId);
  db.prepare('DELETE FROM gate_results WHERE job_id = ?').run(jobId);
  db.prepare('DELETE FROM job_metrics WHERE job_id = ?').run(jobId);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  initDb,
  getDb,
  saveJob,
  loadJob,
  loadAllJobs,
  deleteOldJobs,
  deleteJob,
  saveMetric,
  saveGateFix,
  saveWhyLedger,
  // Job Spec
  updateJobSpec,
  getJobBySpec,
  // Gate Results
  saveGateResult,
  getGateResults,
  // Publish Results
  savePublishResult,
  markJobPublished,
  // Assembly Jobs
  saveAssemblyJob,
  getAssemblyJob,
  // HeyGen Renders
  saveHeyGenRender,
  getHeyGenRenders,
};
