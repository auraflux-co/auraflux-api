'use strict';
// lib/db.js — SQLite persistence layer for CWN job cards, metrics, and gate fixes.
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

  console.log(`[db] SQLite opened: ${DB_PATH}`);
  return _db;
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

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  initDb,
  saveJob,
  loadJob,
  loadAllJobs,
  deleteOldJobs,
  saveMetric,
  saveGateFix,
};
