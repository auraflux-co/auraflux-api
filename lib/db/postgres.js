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
  // Render-managed Postgres uses a self-signed certificate on the internal network.
  // rejectUnauthorized: false is Render's documented recommendation for internal
  // connections. If PGSSLROOTCERT env var is provided (Render CA cert path), full
  // chain validation is enabled instead.
  const isLocalhost = process.env.DATABASE_URL.includes('localhost') ||
                      process.env.DATABASE_URL.includes('127.0.0.1');
  let sslConfig;
  if (isLocalhost) {
    sslConfig = false;
  } else if (process.env.PGSSLROOTCERT) {
    const fs = require('fs');
    sslConfig = { rejectUnauthorized: true, ca: fs.readFileSync(process.env.PGSSLROOTCERT).toString() };
  } else {
    sslConfig = { rejectUnauthorized: false };
  }

  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslConfig,
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
  const migrationsDir = path.join(__dirname, '../../db/migrations');

  // Ensure schema_migrations table exists before we query it
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT        PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const { rows: applied } = await pool.query(
    'SELECT version FROM schema_migrations ORDER BY version ASC'
  );
  const appliedSet = new Set(applied.map((r) => r.version));

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = file.replace('.sql', '');
    if (appliedSet.has(version)) {
      console.log(`[db/postgres] Migration already applied: ${version}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
    console.log(`[db/postgres] Migration applied: ${version}`);
  }

  console.log('[db/postgres] All migrations up to date — ready');
  return pool;
}

async function closeDb() {
  if (!_pool) return;
  await _pool.end();
  _pool = null;
}

// ── Generic query helper (used by services that don't need named helpers) ─────

async function query(sql, params) {
  const pool = getPool();
  return pool.query(sql, params);
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
  const newStatus = jobSpec.status || null;
  const serialized = JSON.stringify(jobSpec);
  // Guard: never overwrite a terminal status (complete/failed/published/cancelled)
  // with a non-terminal one. This prevents fire-and-forget 'running' writes from
  // racing past an awaited 'complete' write and resetting the job status.
  await pool.query(
    `UPDATE jobs
     SET job_spec    = $1,
         customer_id = $2,
         template_id = $3,
         updated_at  = $4
     WHERE id = $5
       AND NOT (
         job_spec IS NOT NULL
         AND job_spec->>'status' IN ('complete','failed','published','cancelled')
         AND $6 NOT IN ('complete','failed','published','cancelled')
       )`,
    [
      serialized,
      jobSpec.customerId || null,
      jobSpec.templateId || null,
      Date.now(),
      jobId,
      newStatus || '',
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

/**
 * Fetch all publish results for a job — platform URLs and status (CPD-112).
 * Returns an array: [{ platform, platformJobId, driveUrl, title, status, publishedAt }]
 */
async function getPublishResults(jobId) {
  const pool = getPool();
  const cid = await resolveCanonicalJobId(jobId).catch(() => jobId);
  const { rows } = await pool.query(
    `SELECT platform, platform_job_id, drive_url, title, status, published_at, created_at
     FROM publish_results
     WHERE job_id = $1
     ORDER BY created_at ASC`,
    [cid]
  );
  return rows.map((r) => ({
    platform:      r.platform,
    platformJobId: r.platform_job_id,
    driveUrl:      r.drive_url,
    title:         r.title,
    status:        r.status,
    publishedAt:   r.published_at ? new Date(parseInt(r.published_at, 10)).toISOString() : null,
  }));
}

/**
 * Update the status of a specific platform publish result (CPD-39).
 * Used by confirm/retry endpoints to track approve/reject/retry state.
 */
async function updatePublishStatus(jobId, platform, status) {
  const pool = getPool();
  const cid = await resolveCanonicalJobId(jobId);
  await pool.query(
    `UPDATE publish_results SET status = $1 WHERE job_id = $2 AND platform = $3`,
    [status, cid, platform]
  );
}

// ── Credit Ledger (CPD-42) ──────────────────────────────────────────────────────

/**
 * Fetch the active plan for a client. Returns null if no plan found.
 */
async function getClientPlan(clientId) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM client_plans WHERE client_id = $1 AND active = TRUE LIMIT 1',
    [clientId]
  );
  return rows[0] || null;
}

/**
 * Monthly credit allocation and overage rate per plan tier.
 * Source of truth: feature-gating.mdc — update both if credits change.
 */
const PLAN_DEFAULTS = {
  diy:    { credits_included: 50,   overage_price_cents: 25 },
  dwy:    { credits_included: 200,  overage_price_cents: 15 },
  dfy:    { credits_included: 1000, overage_price_cents: 10 },
  custom: { credits_included: 9999, overage_price_cents: 0  },
};

/**
 * Get or create a client_plans row.  For new sign-ups who have a Clerk planTier
 * but no Stripe subscription yet (or test accounts), this ensures the credits
 * page and billing endpoints work from day 1 without an error.
 *
 * @param {string} clientId - Clerk user ID
 * @param {'diy'|'dwy'|'dfy'|'custom'} [tier='diy'] - from Clerk publicMetadata
 */
async function getOrCreateClientPlan(clientId, tier = 'diy') {
  const pool = getPool();
  const existing = await getClientPlan(clientId);
  if (existing) return existing;

  const { credits_included, overage_price_cents } = PLAN_DEFAULTS[tier] || PLAN_DEFAULTS.diy;

  const { rows } = await pool.query(
    `INSERT INTO client_plans (client_id, tier, credits_included, overage_price_cents, billing_anchor_day, active)
     VALUES ($1, $2, $3, $4, $5, TRUE)
     ON CONFLICT (client_id) DO UPDATE
       SET tier                = EXCLUDED.tier,
           credits_included    = EXCLUDED.credits_included,
           overage_price_cents = EXCLUDED.overage_price_cents,
           active              = TRUE
     RETURNING *`,
    [clientId, tier, credits_included, overage_price_cents, 1]
  );
  return rows[0];
}

/**
 * Compute credit balance for a client in the current billing period.
 * Returns { includedUsed, includedRemaining, packCredits, overageUsed }.
 */
async function getCreditBalance(clientId) {
  const pool = getPool();
  const plan = await getClientPlan(clientId);
  if (!plan) return null;

  // Compute current period start (anchor day this or previous month)
  const now = new Date();
  const anchor = plan.billing_anchor_day;
  let periodStart = new Date(now.getFullYear(), now.getMonth(), anchor);
  if (periodStart > now) periodStart = new Date(now.getFullYear(), now.getMonth() - 1, anchor);

  const { rows: ledger } = await pool.query(
    `SELECT type, SUM(credits_used) AS total
     FROM credit_ledger
     WHERE client_id = $1 AND created_at >= $2
     GROUP BY type`,
    [clientId, periodStart.toISOString()]
  );

  const { rows: packs } = await pool.query(
    `SELECT SUM(credits_remaining) AS total
     FROM credit_packs
     WHERE client_id = $1
       AND credits_remaining > 0
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [clientId]
  );

  const byType = Object.fromEntries(ledger.map((r) => [r.type, parseInt(r.total, 10) || 0]));
  const includedUsed = byType.included || 0;
  const packCredits = parseInt(packs[0]?.total, 10) || 0;

  return {
    includedUsed,
    includedRemaining: Math.max(0, plan.credits_included - includedUsed),
    packCredits,
    overageUsed: byType.overage || 0,
    creditsIncluded: plan.credits_included,
    tier: plan.tier,
    periodStart: periodStart.toISOString(),
  };
}

/**
 * Append a credit consumption event to the ledger.
 */
async function logCreditEvent(clientId, jobId, creditsUsed, type, packId = null) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO credit_ledger (client_id, job_id, credits_used, type, pack_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [clientId, jobId || null, creditsUsed, type, packId || null]
  );
}

/**
 * Get active credit packs for FIFO consumption (oldest expiring first).
 */
async function getActivePacks(clientId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM credit_packs
     WHERE client_id = $1
       AND credits_remaining > 0
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY expires_at ASC NULLS LAST, created_at ASC`,
    [clientId]
  );
  return rows;
}

/**
 * Deduct credits from a pack (for FIFO pack consumption).
 */
async function deductPackCredits(packId, amount) {
  const pool = getPool();
  await pool.query(
    `UPDATE credit_packs
     SET credits_remaining = GREATEST(0, credits_remaining - $1)
     WHERE id = $2`,
    [amount, packId]
  );
}

/**
 * Get or create the current open billing period for a client.
 */
async function getOrCreateBillingPeriod(clientId) {
  const pool = getPool();
  const plan = await getClientPlan(clientId);
  if (!plan) return null;

  const now = new Date();
  const anchor = plan.billing_anchor_day;
  let start = new Date(now.getFullYear(), now.getMonth(), anchor);
  if (start > now) start = new Date(now.getFullYear(), now.getMonth() - 1, anchor);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, anchor - 1);

  const periodStart = start.toISOString().split('T')[0];
  const periodEnd = end.toISOString().split('T')[0];

  const { rows } = await pool.query(
    `INSERT INTO billing_periods (client_id, period_start, period_end)
     VALUES ($1, $2, $3)
     ON CONFLICT (client_id, period_start) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [clientId, periodStart, periodEnd]
  );
  return rows[0];
}

// ── Stripe / Credit Packs (CPD-45) ───────────────────────────────────────────

/**
 * Insert a new credit pack after successful Stripe payment.
 */
async function insertCreditPack(clientId, creditsPurchased, stripePaymentId, expiresAt = null) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO credit_packs (client_id, credits_purchased, credits_remaining, stripe_payment_id, expires_at)
     VALUES ($1, $2, $2, $3, $4)
     RETURNING *`,
    [clientId, creditsPurchased, stripePaymentId || null, expiresAt || null]
  );
  return rows[0];
}

/**
 * Check if a Stripe event has already been processed (idempotency guard).
 */
async function hasStripeEvent(eventId) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT 1 FROM stripe_events WHERE event_id = $1',
    [eventId]
  );
  return rows.length > 0;
}

/**
 * Record a processed Stripe event to prevent duplicate processing.
 */
async function recordStripeEvent(eventId, eventType) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO stripe_events (event_id, event_type) VALUES ($1, $2)
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId, eventType]
  );
}

/**
 * Update a client's billing plan tier (on subscription change events).
 * @param {string} clientId
 * @param {'diy'|'dwy'|'dfy'|'custom'} tier
 * @param {string|null} stripeSubscriptionId
 * @returns {Promise<boolean>} true if a row was updated
 */
async function updateClientPlanTier(clientId, tier, stripeSubscriptionId = null) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `UPDATE client_plans
     SET tier = $1,
         stripe_subscription_id = COALESCE($2, stripe_subscription_id)
     WHERE client_id = $3`,
    [tier, stripeSubscriptionId || null, clientId]
  );
  return (rowCount || 0) > 0;
}

// ── Voice Profiles ────────────────────────────────────────────────────────────

/**
 * Get the voice profile for a client.
 * @param {string} clientId
 * @returns {Promise<object|null>}
 */
async function getVoiceProfile(clientId) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT voice_profile FROM client_plans WHERE client_id = $1 AND active = TRUE LIMIT 1',
    [clientId]
  );
  return rows.length ? rows[0].voice_profile || null : null;
}

/**
 * Save or update the voice profile for a client.
 * @param {string} clientId
 * @param {object} profile - { selectedVoiceId, recommendations, characteristics }
 * @returns {Promise<boolean>} true if updated
 */
async function saveVoiceProfile(clientId, profile) {
  const pool = getPool();
  const payload = { ...profile, updatedAt: new Date().toISOString() };
  const { rowCount } = await pool.query(
    `UPDATE client_plans
     SET voice_profile = $1
     WHERE client_id = $2 AND active = TRUE`,
    [JSON.stringify(payload), clientId]
  );
  return (rowCount || 0) > 0;
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

// ── Seed Job Spec ─────────────────────────────────────────────────────────────

/**
 * Set job_spec only if the row exists and job_spec is currently NULL.
 * Mirrors the SQLite seedJobSpecFromScript signature.
 * Returns true if seeded, false if already populated or row missing.
 */
async function seedJobSpecFromScript(jobId, jobSpecObj) {
  const pool = getPool();
  const { rows } = await pool.query('SELECT id, job_spec FROM jobs WHERE id = $1', [jobId]);
  if (!rows.length) return false;
  if (rows[0].job_spec != null) return false;
  const spec =
    jobSpecObj && typeof jobSpecObj === 'object' ? JSON.parse(JSON.stringify(jobSpecObj)) : {};
  spec.jobId = spec.jobId || jobId;
  spec.scriptJobId = spec.scriptJobId || jobId;
  spec.state = spec.state || { gateResults: {}, savedOutputs: {} };
  spec.state.gateResults = spec.state.gateResults || {};
  await pool.query('UPDATE jobs SET job_spec = $1, updated_at = $2 WHERE id = $3', [
    JSON.stringify(spec),
    Date.now(),
    jobId,
  ]);
  return true;
}

/**
 * No-op on Postgres — the JSONB job_spec column always reflects the latest state.
 * Exists for API parity with the SQLite adapter.
 */
async function syncJobCardScriptGateSnapshot() {
  return true;
}

/**
 * On Postgres the primary key IS the job ID — return jobId directly.
 * Exists for API parity with the SQLite adapter (which returns a rowid integer).
 */
async function getPrimaryJobSpecRowId(jobId) {
  return jobId;
}

// ── Scheduling (CPD-48) ───────────────────────────────────────────────────────

async function updateJobPublishSchedule(jobId, publishMode, scheduledAt) {
  const pool = getPool();
  await pool.query(
    'UPDATE jobs SET publish_mode = $1, scheduled_publish_at = $2, updated_at = $3 WHERE id = $4',
    [publishMode, scheduledAt ?? null, Date.now(), jobId]
  );
}

async function getJobsDueForScheduledPublish() {
  const pool = getPool();
  const now = Date.now();
  const { rows } = await pool.query(
    `SELECT * FROM jobs
     WHERE  publish_mode         = 'scheduled'
     AND    status               = 'ready_to_publish'
     AND    scheduled_publish_at IS NOT NULL
     AND    scheduled_publish_at <= $1
     AND    actual_published_at  IS NULL`,
    [now]
  );
  return rows;
}

async function markJobActuallyPublished(jobId) {
  const pool = getPool();
  const now = Date.now();
  await pool.query(
    `UPDATE jobs
     SET status             = 'published',
         actual_published_at = $1,
         updated_at          = $1
     WHERE id = $2`,
    [now, jobId]
  );
}

// ── Sync in-memory resolve (for EventEmitter / BullMQ sync contexts) ─────────
// Reads from persistedJobs (loaded from Postgres at startup) so no DB round-trip.
// Falls back to returning jobId unchanged if the job is not yet in memory.
function resolveCanonicalJobIdSync(jobId) {
  if (!jobId || typeof jobId !== 'string') return jobId;
  try {
    const { persistedJobs } = require('../job_card');
    const job = persistedJobs[jobId];
    if (job && job.scriptJobId) return job.scriptJobId;
  } catch (_e) { /* non-fatal */ }
  return jobId;
}

// ── Customer-scoped job list (C1+ dashboard GET /jobs) ────────────────────────
async function listJobsByCustomer(customerId, limit = 50) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT id, customer_id, job_spec, created_at, updated_at FROM jobs WHERE customer_id = $1 ORDER BY created_at DESC LIMIT $2',
    [customerId, limit]
  );
  return rows;
}

async function listAllJobRows(limit = 100) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT id, customer_id, job_spec, created_at, updated_at FROM jobs ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return rows;
}

async function loadJobRow(jobId) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT id, customer_id, job_spec, created_at, updated_at FROM jobs WHERE id = $1',
    [jobId]
  );
  return rows[0] || null;
}

/**
 * Return all jobs whose job_spec status is 'running' and that were last
 * updated more than `staleSecs` seconds ago.  Used by startup rescue to
 * detect jobs abandoned mid-pipeline by a previous process exit.
 *
 * @param {number} [staleSecs=60]
 * @returns {Promise<Array<{id, customer_id, job_spec}>>}
 */
async function loadRunningJobs(staleSecs = 60) {
  const pool = getPool();
  const cutoff = Date.now() - staleSecs * 1000;
  const { rows } = await pool.query(
    `SELECT id, customer_id, job_spec
     FROM jobs
     WHERE job_spec IS NOT NULL
       AND job_spec->>'status' = 'running'
       AND updated_at < $1`,
    [cutoff]
  );
  return rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    spec: typeof r.job_spec === 'string' ? JSON.parse(r.job_spec) : r.job_spec,
  }));
}

/**
 * Upsert a job row with job_spec in a single statement.
 * Used by POST /v1/jobs to ensure the row exists before the fire-and-forget
 * portal sequence starts.  The guard on updateJobSpec requires a non-NULL
 * job_spec to apply the terminal-status protection, so this must run first.
 */
async function upsertJobRow(jobId, jobSpec) {
  const pool = getPool();
  const serialized = JSON.stringify(jobSpec);
  const now = Date.now();
  const contentType = jobSpec.contentType || jobSpec.order?.contentType || 'news';
  const formType    = jobSpec.templateId === 'short-form' ? 'short' : 'long';
  // card column is NOT NULL — initialise with minimal job card data
  const initialCard = JSON.stringify({
    jobId,
    customerId: jobSpec.customerId || null,
    contentType,
    status: 'queued',
    savedAt: new Date(now).toISOString(),
  });
  await pool.query(
    `INSERT INTO jobs (id, customer_id, template_id, content_type, form_type, status, stage, card, job_spec, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'queued', 'queued', $6, $7, $8, $8)
     ON CONFLICT (id) DO UPDATE SET
       job_spec     = EXCLUDED.job_spec,
       customer_id  = EXCLUDED.customer_id,
       template_id  = EXCLUDED.template_id,
       content_type = EXCLUDED.content_type,
       form_type    = EXCLUDED.form_type,
       updated_at   = EXCLUDED.updated_at`,
    [jobId, jobSpec.customerId || null, jobSpec.templateId || null, contentType, formType, initialCard, serialized, now]
  );
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  initDb,
  getPool,
  getDb: getPool,
  query,
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
  updatePublishStatus,
  getPublishResults,
  // Credit ledger (CPD-42)
  getClientPlan,
  getOrCreateClientPlan,
  getCreditBalance,
  logCreditEvent,
  getActivePacks,
  deductPackCredits,
  getOrCreateBillingPeriod,
  // Stripe / credit packs (CPD-45, CPD-88)
  insertCreditPack,
  hasStripeEvent,
  recordStripeEvent,
  updateClientPlanTier,
  // Voice profiles (CPD-77)
  getVoiceProfile,
  saveVoiceProfile,
  saveAssemblyJob,
  getAssemblyJob,
  saveHeyGenRender,
  getHeyGenRenders,
  // Job Spec helpers (parity with SQLite adapter)
  seedJobSpecFromScript,
  syncJobCardScriptGateSnapshot,
  getPrimaryJobSpecRowId,
  // Scheduling (CPD-48)
  updateJobPublishSchedule,
  getJobsDueForScheduledPublish,
  markJobActuallyPublished,
  // Scheduled job start (CPD-118)
  updateJobScheduledStart,
  getJobsDueForScheduledStart,
  // Job Templates (CPD-116 / CPD-119)
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  getTemplatesDueForRecurrence,
  bumpTemplateNextFire,
  // Sync helpers (no DB round-trip — reads in-memory persistedJobs)
  resolveCanonicalJobIdSync,
  // C1+ dashboard queries
  listJobsByCustomer,
  listAllJobRows,
  loadJobRow,
  loadRunningJobs,
  upsertJobRow,
  // Support (CPD-115)
  createSupportSession,
  getOrCreateActiveSupportSession,
  findSessionByPhone,
  addSupportMessage,
  listSupportSessions,
  getSessionMessages,
  resolveSession,
  escalateSession,
};

// ── Support helpers (CPD-115) ─────────────────────────────────────────────────

async function createSupportSession(userId, phoneNumber = null) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO support_sessions (user_id, phone_number, created_at)
     VALUES ($1, $2, $3) RETURNING *`,
    [userId, phoneNumber, Date.now()],
  );
  return rows[0];
}

async function getOrCreateActiveSupportSession(userId) {
  const pool = getPool();
  // Return the most recent unresolved web session, or create a new one
  const { rows } = await pool.query(
    `SELECT * FROM support_sessions
     WHERE user_id = $1 AND resolved = FALSE AND (phone_number IS NULL OR phone_number = '')
     ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  if (rows.length) return rows[0];
  return createSupportSession(userId, null);
}

async function findSessionByPhone(phoneNumber) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM support_sessions
     WHERE phone_number = $1 AND resolved = FALSE
     ORDER BY created_at DESC LIMIT 1`,
    [phoneNumber],
  );
  return rows[0] || null;
}

async function addSupportMessage(sessionId, userId, role, content, channel = 'web') {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO support_messages (session_id, user_id, role, content, channel, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [sessionId, userId, role, content, channel, Date.now()],
  );
  return rows[0];
}

async function listSupportSessions(userId, limit = 20) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT s.*, COUNT(m.id)::int AS message_count
     FROM support_sessions s
     LEFT JOIN support_messages m ON m.session_id = s.id
     WHERE s.user_id = $1
     GROUP BY s.id
     ORDER BY s.created_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

async function getSessionMessages(sessionId, userId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM support_messages
     WHERE session_id = $1 AND user_id = $2
     ORDER BY created_at ASC`,
    [sessionId, userId],
  );
  return rows;
}

async function resolveSession(sessionId) {
  const pool = getPool();
  await pool.query(
    `UPDATE support_sessions SET resolved = TRUE WHERE id = $1`,
    [sessionId],
  );
}

async function escalateSession(sessionId, channel) {
  const pool = getPool();
  await pool.query(
    `UPDATE support_sessions SET escalated = TRUE, escalation_channel = $2 WHERE id = $1`,
    [sessionId, channel],
  );
}

// ── Job Templates (CPD-116 / CPD-119) ─────────────────────────────────────────

async function createTemplate(customerId, { name, description, contentType, platforms, jobSpec, recurrenceType, recurrenceDay, recurrenceTime }) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO job_templates
       (customer_id, name, description, content_type, platforms, job_spec,
        recurrence_type, recurrence_day, recurrence_time, recurrence_active, next_fire_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
             CASE WHEN $7 IS NOT NULL AND $7 <> 'once' THEN TRUE ELSE FALSE END,
             CASE WHEN $7 IS NOT NULL AND $9 IS NOT NULL THEN $10::TIMESTAMPTZ ELSE NULL END)
     RETURNING *`,
    [customerId, name, description || null, contentType || null,
     platforms || [], JSON.stringify(jobSpec),
     recurrenceType || null, recurrenceDay || null, recurrenceTime || null,
     _nextFireAt(recurrenceType, recurrenceDay, recurrenceTime)],
  );
  return rows[0];
}

async function listTemplates(customerId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM job_templates WHERE customer_id = $1 ORDER BY created_at DESC`,
    [customerId],
  );
  return rows;
}

async function getTemplate(templateId, customerId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM job_templates WHERE id = $1 AND customer_id = $2`,
    [templateId, customerId],
  );
  return rows[0] || null;
}

async function updateTemplate(templateId, customerId, patch) {
  const pool = getPool();
  const fields = [];
  const vals  = [];
  let idx = 1;
  const allowed = ['name','description','content_type','platforms','job_spec',
                   'recurrence_type','recurrence_day','recurrence_time','recurrence_active','next_fire_at'];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    fields.push(`${k} = $${idx++}`);
    vals.push(k === 'job_spec' ? JSON.stringify(v) : v);
  }
  if (!fields.length) return null;
  fields.push(`updated_at = NOW()`);
  vals.push(templateId, customerId);
  const { rows } = await pool.query(
    `UPDATE job_templates SET ${fields.join(',')} WHERE id = $${idx++} AND customer_id = $${idx} RETURNING *`,
    vals,
  );
  return rows[0] || null;
}

async function deleteTemplate(templateId, customerId) {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM job_templates WHERE id = $1 AND customer_id = $2`,
    [templateId, customerId],
  );
  return rowCount > 0;
}

async function getTemplatesDueForRecurrence() {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM job_templates
     WHERE recurrence_active = TRUE
       AND next_fire_at IS NOT NULL
       AND next_fire_at <= NOW()`,
  );
  return rows;
}

async function bumpTemplateNextFire(templateId, recurrenceType, recurrenceDay, recurrenceTime) {
  const pool = getPool();
  const next = _nextFireAt(recurrenceType, recurrenceDay, recurrenceTime);
  await pool.query(
    `UPDATE job_templates SET last_fired_at = NOW(), next_fire_at = $2 WHERE id = $1`,
    [templateId, next],
  );
}

// Compute the next fire timestamp for a given recurrence config.
function _nextFireAt(recurrenceType, recurrenceDay, recurrenceTime) {
  if (!recurrenceType || recurrenceType === 'once' || !recurrenceTime) return null;
  const [hh, mm] = (recurrenceTime || '09:00').split(':').map(Number);
  const now = new Date();
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh, mm, 0));
  if (recurrenceType === 'daily') {
    if (base <= now) base.setUTCDate(base.getUTCDate() + 1);
    return base.toISOString();
  }
  if (recurrenceType === 'weekly') {
    const target = (recurrenceDay ?? 1) % 7;
    let d = new Date(base);
    while (d.getUTCDay() !== target || d <= now) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  }
  if (recurrenceType === 'monthly') {
    const day = recurrenceDay || 1;
    let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, hh, mm, 0));
    if (d <= now) d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, day, hh, mm, 0));
    return d.toISOString();
  }
  return null;
}

// Scheduled job start (CPD-118)
async function updateJobScheduledStart(jobId, scheduledStartAt) {
  const pool = getPool();
  const ts = scheduledStartAt ? new Date(scheduledStartAt).toISOString() : null;
  await pool.query(
    `UPDATE jobs SET scheduled_start_at = $1, status = CASE WHEN $1 IS NOT NULL THEN 'queued_scheduled' ELSE status END, updated_at = NOW() WHERE id = $2`,
    [ts, jobId],
  );
}

async function getJobsDueForScheduledStart() {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, job_spec, customer_id FROM jobs
     WHERE status = 'queued_scheduled'
       AND scheduled_start_at IS NOT NULL
       AND scheduled_start_at <= NOW()`,
  );
  return rows;
}
