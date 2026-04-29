'use strict';
/**
 * lib/db/postgres.js — AuraFlux C1+ PostgreSQL persistence layer.
 *
 * Drop-in async replacement for lib/db.js (SQLite).
 * All functions mirror lib/db.js signatures but return Promises.
 * Uses JSONB columns instead of JSON for indexed querying.
 *
 * Requires: DATABASE_URL env var (injected by Render from auraflux-pg).
 */

const { Pool } = require('pg');

let _pool = null;

// ── Pool ──────────────────────────────────────────────────────────────────────

function getPool() {
  if (_pool) return _pool;
  if (!process.env.DATABASE_URL) {
    throw new Error('[db/postgres] DATABASE_URL is not set — cannot initialize Postgres pool');
  }
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  _pool.on('error', (err) => {
    console.error('[db/postgres] Unexpected pool error:', err.message);
  });

  return _pool;
}

async function initDb() {
  const pool = getPool();
  const fs = require('fs');
  const path = require('path');
  const schema = fs.readFileSync(
    path.join(__dirname, '../../db/migrations/001_initial_schema.sql'),
    'utf8'
  );
  await pool.query(schema);
  console.log('[db/postgres] Schema applied — ready');
  return pool;
}

async function closeDb() {
  if (!_pool) return;
  await _pool.end();
  _pool = null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveCanonicalJobId(jobId) {
  if (!jobId || typeof jobId !== 'string') return jobId;
  const pool = getPool();
  const { rows } = await pool.query('SELECT id, script_job_id FROM jobs WHERE id = $1', [jobId]);
  if (!rows.length) return jobId;
  return rows[0].script_job_id || rows[0].id;
}

async function jobIdsLinkedToCanonical(canonicalId) {
  if (!canonicalId) return [];
  const pool = getPool();
  const ids = new Set([canonicalId]);
  const { rows } = await pool.query('SELECT id FROM jobs WHERE script_job_id = $1', [canonicalId]);
  for (const r of rows) ids.add(r.id);
  return [...ids];
}

// ── Job CRUD ──────────────────────────────────────────────────────────────────

async function saveJob(jobId, card) {
  const pool = getPool();
  const now = Date.now();
  const contentType = card.contentType || card.content_type || '';
  const formType = card.formType || card.form_type || null;
  const status = card.status || 'pending';
  const stage = card.stage || 'script_ready';
  const createdAt = card.createdAt
    ? new Date(card.createdAt).getTime()
    : card.savedAt
      ? new Date(card.savedAt).getTime()
      : now;

  await pool.query(
    `INSERT INTO jobs (id, content_type, form_type, status, stage, created_at, updated_at, card)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       content_type = EXCLUDED.content_type,
       form_type    = EXCLUDED.form_type,
       status       = EXCLUDED.status,
       stage        = EXCLUDED.stage,
       updated_at   = EXCLUDED.updated_at,
       card         = EXCLUDED.card`,
    [jobId, contentType, formType, status, stage, createdAt, now, JSON.stringify(card)]
  );
}

async function loadJob(jobId) {
  const pool = getPool();
  const { rows } = await pool.query('SELECT card FROM jobs WHERE id = $1', [jobId]);
  if (!rows.length) return null;
  return typeof rows[0].card === 'string' ? JSON.parse(rows[0].card) : rows[0].card;
}

async function loadAllJobs() {
  const pool = getPool();
  const { rows } = await pool.query('SELECT card FROM jobs ORDER BY created_at DESC LIMIT 200');
  return rows
    .map((r) => (typeof r.card === 'string' ? JSON.parse(r.card) : r.card))
    .filter(Boolean);
}

async function deleteOldJobs(daysOld = 7) {
  const pool = getPool();
  const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000;
  const { rowCount } = await pool.query('DELETE FROM jobs WHERE created_at < $1', [cutoff]);
  if (rowCount > 0) console.log(`[db/postgres] Pruned ${rowCount} jobs older than ${daysOld} days`);
  return rowCount;
}

async function deleteJob(jobId) {
  const pool = getPool();
  await pool.query('DELETE FROM why_ledger    WHERE job_id = $1', [jobId]);
  await pool.query('DELETE FROM gate_results  WHERE job_id = $1', [jobId]);
  await pool.query('DELETE FROM job_metrics   WHERE job_id = $1', [jobId]);
  await pool.query('DELETE FROM jobs          WHERE id     = $1', [jobId]);
}

// ── Metrics ───────────────────────────────────────────────────────────────────

async function saveMetric(jobId, stage, durationMs, data) {
  const pool = getPool();
  const cid = await resolveCanonicalJobId(jobId);
  await pool.query(
    `INSERT INTO job_metrics (job_id, stage, duration_ms, data, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [cid, stage, durationMs ?? null, data ? JSON.stringify(data) : null, Date.now()]
  );
}

// ── Gate Fixes ────────────────────────────────────────────────────────────────

async function saveGateFix(jobId, gate, scoreBefore, scoreAfter, action, reason) {
  const pool = getPool();
  const cid = await resolveCanonicalJobId(jobId);
  await pool.query(
    `INSERT INTO gate_fixes (job_id, gate, score_before, score_after, action, reason, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [cid, gate, scoreBefore ?? null, scoreAfter ?? null, action ?? null, reason ?? null, Date.now()]
  );
}

async function saveWhyLedger(row) {
  const pool = getPool();
  const now = Date.now();
  const cid = await resolveCanonicalJobId(row.jobId);
  await pool.query(
    `INSERT INTO why_ledger (
       job_id, gate, kind, passed, score, outcome,
       failure_class, intervention_type, intervention_outcome,
       reasons_json, contract_digest_json, evidence_digest_json, source, meta_json, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      cid,
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
      now,
    ]
  );
}

// ── Job Spec ──────────────────────────────────────────────────────────────────

async function updateJobSpec(jobId, jobSpec) {
  const pool = getPool();
  await pool.query(
    `UPDATE jobs
     SET job_spec    = $1,
         customer_id = $2,
         template_id = $3,
         updated_at  = $4
     WHERE id = $5`,
    [
      JSON.stringify(jobSpec),
      jobSpec.customerId || null,
      jobSpec.templateId || null,
      Date.now(),
      jobId,
    ]
  );
}

async function getJobBySpec(jobId) {
  const pool = getPool();
  let rows;

  ({ rows } = await pool.query('SELECT job_spec FROM jobs WHERE id = $1', [jobId]));
  if (!rows.length || !rows[0].job_spec) {
    ({ rows } = await pool.query('SELECT job_spec FROM jobs WHERE script_job_id = $1 LIMIT 1', [
      jobId,
    ]));
  }
  if (!rows.length || !rows[0].job_spec) {
    ({ rows } = await pool.query(
      `SELECT job_spec FROM jobs WHERE job_spec IS NOT NULL AND job_spec->>'scriptJobId' = $1 LIMIT 1`,
      [jobId]
    ));
  }
  if (!rows.length || !rows[0].job_spec) return null;
  const spec = rows[0].job_spec;
  return typeof spec === 'string' ? JSON.parse(spec) : spec;
}

// ── Gate Results ──────────────────────────────────────────────────────────────

async function saveGateResult(jobId, gate, result) {
  const pool = getPool();
  const cid = await resolveCanonicalJobId(jobId);
  const payload =
    result && typeof result === 'object' && !Array.isArray(result)
      ? { ...result, jobId: cid }
      : result;
  await pool.query(
    `INSERT INTO gate_results (job_id, gate, passed, score, result, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [cid, gate, result.passed ? 1 : 0, result.score ?? null, JSON.stringify(payload), Date.now()]
  );
}

async function getGateResults(jobId) {
  const pool = getPool();
  const canonical = await resolveCanonicalJobId(jobId);
  const ids = await jobIdsLinkedToCanonical(canonical);
  if (!ids.length) return {};

  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `SELECT gate, result FROM gate_results WHERE job_id IN (${placeholders}) ORDER BY id ASC`,
    ids
  );

  const out = {};
  for (const row of rows) {
    out[row.gate] = typeof row.result === 'string' ? JSON.parse(row.result) : row.result;
  }
  return out;
}

// ── Publish Results ───────────────────────────────────────────────────────────

async function savePublishResult(jobId, platform, { platformJobId, driveUrl, title, status }) {
  const pool = getPool();
  const cid = await resolveCanonicalJobId(jobId);
  await pool.query(
    `INSERT INTO publish_results (job_id, platform, platform_job_id, drive_url, title, status, published_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      cid,
      platform,
      platformJobId || null,
      driveUrl || null,
      title || null,
      status || 'pending',
      status === 'published' ? Date.now() : null,
      Date.now(),
    ]
  );
}

async function markJobPublished(jobId, driveUrl) {
  const pool = getPool();
  await pool.query('UPDATE jobs SET drive_url = $1, published_at = $2, status = $3 WHERE id = $4', [
    driveUrl || null,
    Date.now(),
    'published',
    jobId,
  ]);
}

// ── Assembly Jobs ─────────────────────────────────────────────────────────────

async function saveAssemblyJob(asmId, jobId, data = {}) {
  const pool = getPool();
  const now = Date.now();
  const cid = await resolveCanonicalJobId(jobId);
  await pool.query(
    `INSERT INTO assembly_jobs (
       id, job_id, content_type, format, status, out_path, drive_url,
       gate2_score, gate3a_score, gate3b_outcome, gate4_score,
       started_at, completed_at, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (id) DO UPDATE SET
       status         = EXCLUDED.status,
       out_path       = COALESCE(EXCLUDED.out_path,       assembly_jobs.out_path),
       drive_url      = COALESCE(EXCLUDED.drive_url,      assembly_jobs.drive_url),
       gate2_score    = COALESCE(EXCLUDED.gate2_score,    assembly_jobs.gate2_score),
       gate3a_score   = COALESCE(EXCLUDED.gate3a_score,   assembly_jobs.gate3a_score),
       gate3b_outcome = COALESCE(EXCLUDED.gate3b_outcome, assembly_jobs.gate3b_outcome),
       gate4_score    = COALESCE(EXCLUDED.gate4_score,    assembly_jobs.gate4_score),
       completed_at   = COALESCE(EXCLUDED.completed_at,   assembly_jobs.completed_at)`,
    [
      asmId,
      cid,
      data.contentType || null,
      data.format || 'mp4',
      data.status || 'assembling',
      data.outPath || null,
      data.driveUrl || null,
      data.gate2Score ?? null,
      data.gate3aScore ?? null,
      data.gate3bOutcome || null,
      data.gate4Score ?? null,
      data.startedAt || now,
      data.completedAt || null,
      now,
    ]
  );
}

async function getAssemblyJob(asmId) {
  const pool = getPool();
  const { rows } = await pool.query('SELECT * FROM assembly_jobs WHERE id = $1', [asmId]);
  return rows[0] || null;
}

// ── HeyGen Renders (C0 legacy — available for historical queries) ─────────────

async function saveHeyGenRender(jobId, videoId, sceneName, status, data = {}) {
  const pool = getPool();
  const now = Date.now();
  const cid = await resolveCanonicalJobId(jobId);
  await pool.query(
    `INSERT INTO heygen_renders (job_id, video_id, scene_name, status, render_time_ms, video_url, created_at, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (video_id) DO UPDATE SET
       status         = EXCLUDED.status,
       render_time_ms = COALESCE(EXCLUDED.render_time_ms, heygen_renders.render_time_ms),
       video_url      = COALESCE(EXCLUDED.video_url,      heygen_renders.video_url),
       completed_at   = COALESCE(EXCLUDED.completed_at,   heygen_renders.completed_at)`,
    [
      cid,
      videoId,
      sceneName,
      status,
      data.renderTimeMs || null,
      data.videoUrl || null,
      now,
      status === 'completed' ? now : null,
    ]
  );
}

async function getHeyGenRenders(jobId) {
  const pool = getPool();
  const canonical = await resolveCanonicalJobId(jobId);
  const ids = await jobIdsLinkedToCanonical(canonical);
  if (!ids.length) return [];
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await pool.query(
    `SELECT * FROM heygen_renders WHERE job_id IN (${placeholders}) ORDER BY id`,
    ids
  );
  return rows;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  initDb,
  getPool,
  closeDb,
  resolveCanonicalJobId,
  jobIdsLinkedToCanonical,
  saveJob,
  loadJob,
  loadAllJobs,
  deleteOldJobs,
  deleteJob,
  saveMetric,
  saveGateFix,
  saveWhyLedger,
  updateJobSpec,
  getJobBySpec,
  saveGateResult,
  getGateResults,
  savePublishResult,
  markJobPublished,
  saveAssemblyJob,
  getAssemblyJob,
  saveHeyGenRender,
  getHeyGenRenders,
};
