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
    { name: 'job_spec',     ddl: 'ALTER TABLE jobs ADD COLUMN job_spec JSON' },
    { name: 'customer_id',  ddl: 'ALTER TABLE jobs ADD COLUMN customer_id TEXT' },
    { name: 'template_id',  ddl: 'ALTER TABLE jobs ADD COLUMN template_id TEXT' },
    { name: 'failed_gate',  ddl: 'ALTER TABLE jobs ADD COLUMN failed_gate INTEGER' },
    { name: 'root_cause',   ddl: 'ALTER TABLE jobs ADD COLUMN root_cause TEXT' },
    { name: 'restart_gate', ddl: 'ALTER TABLE jobs ADD COLUMN restart_gate INTEGER' },
  ];

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
  // If not found, search job_spec JSON for scriptJobId cross-reference
  // (script job IDs like script_news_... are stored inside the job_spec)
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

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  initDb,
  saveJob,
  loadJob,
  loadAllJobs,
  deleteOldJobs,
  saveMetric,
  saveGateFix,
  // Job Spec
  updateJobSpec,
  getJobBySpec,
  // Gate Results
  saveGateResult,
  getGateResults,
};
