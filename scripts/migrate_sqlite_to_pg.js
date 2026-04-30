#!/usr/bin/env node
'use strict';
/**
 * scripts/migrate_sqlite_to_pg.js
 *
 * One-shot migration: copies all data from the SQLite database (data/cwn.db)
 * into the Render PostgreSQL instance (DATABASE_URL).
 *
 * Safe to run multiple times — uses ON CONFLICT DO NOTHING for all inserts.
 *
 * Usage (local test):
 *   DATABASE_URL=postgresql://... node scripts/migrate_sqlite_to_pg.js
 *
 * Usage (Render shell / one-off job):
 *   node scripts/migrate_sqlite_to_pg.js
 *   (DATABASE_URL is injected automatically from the linked auraflux-pg service)
 *
 * Tables migrated (in dependency order):
 *   jobs → job_metrics → gate_fixes → gate_results → publish_results
 *   → assembly_jobs → heygen_renders → why_ledger
 */

require('dotenv').config();

const path    = require('path');
const fs      = require('fs');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

// ── Config ────────────────────────────────────────────────────────────────────

const DB_PATH = process.env.CWN_DB_PATH
  ? path.resolve(process.env.CWN_DB_PATH)
  : path.join(__dirname, '..', 'data', 'cwn.db');

if (!process.env.DATABASE_URL) {
  console.error('[migrate] DATABASE_URL is not set. Exiting.');
  process.exit(1);
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`[migrate] SQLite DB not found at ${DB_PATH}. Exiting.`);
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeJson(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return JSON.stringify(val);
  try {
    JSON.parse(val);
    return val;
  } catch {
    return null;
  }
}

async function applySchema(pg) {
  // Use the same migration runner as initDb() so all migrations are applied
  // in sorted order and tracked in schema_migrations.
  const { initDb } = require('../lib/db/postgres');
  await initDb();
  console.log('[migrate] All migrations applied via initDb().');
}

// ── Table migrations ──────────────────────────────────────────────────────────

async function migrateJobs(sqlite, pg) {
  const rows = sqlite.prepare('SELECT * FROM jobs').all();
  console.log(`[migrate] jobs: ${rows.length} rows`);
  let inserted = 0;

  for (const row of rows) {
    const res = await pg.query(
      `INSERT INTO jobs (
         id, content_type, form_type, status, stage,
         job_spec, customer_id, template_id, failed_gate, root_cause,
         restart_gate, script_job_id, drive_url, published_at,
         created_at, updated_at, card,
         publish_mode, scheduled_publish_at, actual_published_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (id) DO NOTHING`,
      [
        row.id,
        row.content_type,
        row.form_type         || null,
        row.status            || 'pending',
        row.stage             || 'script_ready',
        safeJson(row.job_spec),
        row.customer_id       || null,
        row.template_id       || null,
        row.failed_gate       ?? null,
        row.root_cause        || null,
        row.restart_gate      ?? null,
        row.script_job_id     || null,
        row.drive_url         || null,
        row.published_at      ?? null,
        row.created_at,
        row.updated_at,
        safeJson(row.card),
        row.publish_mode      || null,
        row.scheduled_publish_at ?? null,
        row.actual_published_at  ?? null,
      ]
    );
    inserted += res.rowCount;
  }
  console.log(`[migrate] jobs: ${inserted} inserted (${rows.length - inserted} skipped as duplicates)`);
}

async function migrateJobMetrics(sqlite, pg) {
  let rows;
  try {
    rows = sqlite.prepare('SELECT * FROM job_metrics').all();
  } catch (e) {
    console.warn('[migrate] job_metrics: table not found, skipping');
    return;
  }
  console.log(`[migrate] job_metrics: ${rows.length} rows`);
  let inserted = 0;
  for (const row of rows) {
    const res = await pg.query(
      `INSERT INTO job_metrics (id, job_id, stage, duration_ms, data, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT DO NOTHING`,
      [row.id, row.job_id, row.stage, row.duration_ms ?? null, safeJson(row.data), row.created_at]
    );
    inserted += res.rowCount;
  }
  console.log(`[migrate] job_metrics: ${inserted} inserted`);
}

async function migrateGateFixes(sqlite, pg) {
  let rows;
  try {
    rows = sqlite.prepare('SELECT * FROM gate_fixes').all();
  } catch (e) {
    console.warn('[migrate] gate_fixes: table not found, skipping');
    return;
  }
  console.log(`[migrate] gate_fixes: ${rows.length} rows`);
  let inserted = 0;
  for (const row of rows) {
    const res = await pg.query(
      `INSERT INTO gate_fixes (id, job_id, gate, score_before, score_after, action, reason, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING`,
      [row.id, row.job_id, row.gate, row.score_before ?? null, row.score_after ?? null,
       row.action || null, row.reason || null, row.created_at]
    );
    inserted += res.rowCount;
  }
  console.log(`[migrate] gate_fixes: ${inserted} inserted`);
}

async function migrateGateResults(sqlite, pg) {
  let rows;
  try {
    rows = sqlite.prepare('SELECT * FROM gate_results').all();
  } catch (e) {
    console.warn('[migrate] gate_results: table not found, skipping');
    return;
  }
  console.log(`[migrate] gate_results: ${rows.length} rows`);
  let inserted = 0;
  for (const row of rows) {
    const res = await pg.query(
      `INSERT INTO gate_results (id, job_id, gate, passed, score, result, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING`,
      [row.id, row.job_id, row.gate, row.passed, row.score ?? null, safeJson(row.result), row.created_at]
    );
    inserted += res.rowCount;
  }
  console.log(`[migrate] gate_results: ${inserted} inserted`);
}

async function migratePublishResults(sqlite, pg) {
  let rows;
  try {
    rows = sqlite.prepare('SELECT * FROM publish_results').all();
  } catch (e) {
    console.warn('[migrate] publish_results: table not found, skipping');
    return;
  }
  console.log(`[migrate] publish_results: ${rows.length} rows`);
  let inserted = 0;
  for (const row of rows) {
    const res = await pg.query(
      `INSERT INTO publish_results (id, job_id, platform, platform_job_id, drive_url, title, status, published_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING`,
      [row.id, row.job_id, row.platform, row.platform_job_id || null, row.drive_url || null,
       row.title || null, row.status || 'pending', row.published_at ?? null, row.created_at]
    );
    inserted += res.rowCount;
  }
  console.log(`[migrate] publish_results: ${inserted} inserted`);
}

async function migrateAssemblyJobs(sqlite, pg) {
  let rows;
  try {
    rows = sqlite.prepare('SELECT * FROM assembly_jobs').all();
  } catch (e) {
    console.warn('[migrate] assembly_jobs: table not found, skipping');
    return;
  }
  console.log(`[migrate] assembly_jobs: ${rows.length} rows`);
  let inserted = 0;
  for (const row of rows) {
    const res = await pg.query(
      `INSERT INTO assembly_jobs (id, job_id, content_type, format, status, out_path, drive_url,
         gate2_score, gate3a_score, gate3b_outcome, gate4_score, started_at, completed_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO NOTHING`,
      [row.id, row.job_id, row.content_type || null, row.format || 'mp4',
       row.status || 'assembling', row.out_path || null, row.drive_url || null,
       row.gate2_score ?? null, row.gate3a_score ?? null, row.gate3b_outcome || null,
       row.gate4_score ?? null, row.started_at, row.completed_at || null, row.created_at]
    );
    inserted += res.rowCount;
  }
  console.log(`[migrate] assembly_jobs: ${inserted} inserted`);
}

async function migrateHeygenRenders(sqlite, pg) {
  let rows;
  try {
    rows = sqlite.prepare('SELECT * FROM heygen_renders').all();
  } catch (e) {
    console.warn('[migrate] heygen_renders: table not found, skipping');
    return;
  }
  console.log(`[migrate] heygen_renders: ${rows.length} rows`);
  let inserted = 0;
  for (const row of rows) {
    const res = await pg.query(
      `INSERT INTO heygen_renders (id, job_id, video_id, scene_name, status, render_time_ms, video_url, created_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING`,
      [row.id, row.job_id, row.video_id || null, row.scene_name || null, row.status || 'pending',
       row.render_time_ms ?? null, row.video_url || null, row.created_at, row.completed_at || null]
    );
    inserted += res.rowCount;
  }
  console.log(`[migrate] heygen_renders: ${inserted} inserted`);
}

async function migrateWhyLedger(sqlite, pg) {
  let rows;
  try {
    rows = sqlite.prepare('SELECT * FROM why_ledger').all();
  } catch (e) {
    console.warn('[migrate] why_ledger: table not found, skipping');
    return;
  }
  console.log(`[migrate] why_ledger: ${rows.length} rows`);
  let inserted = 0;
  for (const row of rows) {
    const res = await pg.query(
      `INSERT INTO why_ledger (id, job_id, gate, kind, passed, score, outcome,
         failure_class, intervention_type, intervention_outcome,
         reasons_json, contract_digest_json, evidence_digest_json, source, meta_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT DO NOTHING`,
      [row.id, row.job_id, row.gate || null, row.kind, row.passed ?? null, row.score ?? null,
       row.outcome || null, row.failure_class || null, row.intervention_type || null,
       row.intervention_outcome || null, safeJson(row.reasons_json), safeJson(row.contract_digest_json),
       safeJson(row.evidence_digest_json), row.source || null, safeJson(row.meta_json), row.created_at]
    );
    inserted += res.rowCount;
  }
  console.log(`[migrate] why_ledger: ${inserted} inserted`);
}

// ── Sequence reset (BIGSERIAL primary keys) ───────────────────────────────────

async function resetSequences(pg) {
  const seqTables = [
    'job_metrics', 'gate_fixes', 'gate_results', 'publish_results',
    'assembly_jobs', 'heygen_renders', 'why_ledger',
  ];
  for (const tbl of seqTables) {
    try {
      await pg.query(`SELECT setval(pg_get_serial_sequence('${tbl}', 'id'), COALESCE((SELECT MAX(id) FROM ${tbl}), 0) + 1, false)`);
      console.log(`[migrate] Reset sequence for ${tbl}`);
    } catch (e) {
      console.warn(`[migrate] Could not reset sequence for ${tbl}: ${e.message}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[migrate] Opening SQLite: ${DB_PATH}`);
  const sqlite = new Database(DB_PATH, { readonly: true });

  // Use the shared postgres module so we get the same pool and migration
  // runner as the application server. applySchema() delegates to initDb().
  const pgModule = require('../lib/db/postgres');
  const pg = pgModule.getPool();

  try {
    console.log('[migrate] Applying schema to Postgres (all migrations)...');
    await applySchema(pg);

    console.log('[migrate] Starting data migration...');
    await migrateJobs(sqlite, pg);
    await migrateJobMetrics(sqlite, pg);
    await migrateGateFixes(sqlite, pg);
    await migrateGateResults(sqlite, pg);
    await migratePublishResults(sqlite, pg);
    await migrateAssemblyJobs(sqlite, pg);
    await migrateHeygenRenders(sqlite, pg);
    await migrateWhyLedger(sqlite, pg);
    await resetSequences(pg);

    console.log('[migrate] ✓ Migration complete.');
  } catch (err) {
    console.error('[migrate] FATAL:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    sqlite.close();
    // Do not call pg.end() — the shared pool is managed by lib/db/postgres.js.
  }
}

main();
