#!/usr/bin/env node
'use strict';
/**
 * One-time backfill: move historical rows keyed by semantic job id (c0_*) onto
 * the canonical script_* id when jobs.script_job_id is set.
 *
 * Tables: gate_results, job_metrics, gate_fixes, why_ledger, publish_results,
 *         assembly_jobs, heygen_renders
 *
 * Then:
 *   - gate_results: keep latest row per (job_id, gate) by MAX(id); patch result JSON $.jobId
 *   - publish_results: keep latest row per (job_id, platform) by MAX(id)
 *
 * Usage:
 *   node scripts/backfill_canonical_job_ids.cjs --dry-run
 *   node scripts/backfill_canonical_job_ids.cjs
 *   node scripts/backfill_canonical_job_ids.cjs --db=/path/to/cwn.db
 *
 * Env: CWN_DB_PATH — default data/cwn.db under repo root
 *
 * Backup the DB file before running without --dry-run.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const dbArg = argv.find(a => a.startsWith('--db='));
const DB_PATH = dbArg
  ? path.resolve(dbArg.slice('--db='.length))
  : (process.env.CWN_DB_PATH
    ? path.resolve(process.env.CWN_DB_PATH)
    : path.join(__dirname, '..', 'data', 'cwn.db'));

const TABLES = [
  'gate_results',
  'job_metrics',
  'gate_fixes',
  'why_ledger',
  'publish_results',
  'assembly_jobs',
  'heygen_renders',
];

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('[backfill] DB not found:', DB_PATH);
    process.exit(1);
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const links = db.prepare(`
    SELECT id AS semantic_id, script_job_id AS canonical_id
    FROM jobs
    WHERE script_job_id IS NOT NULL AND TRIM(script_job_id) != ''
  `).all();

  const valid = links.filter((row) => {
    const ok = !!db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(row.canonical_id);
    if (!ok) {
      console.warn('[backfill] skip broken link (canonical row missing):', row.semantic_id, '→', row.canonical_id);
    }
    return ok;
  });

  if (valid.length === 0) {
    console.log('[backfill] No linked semantic→script rows; nothing to do.');
    db.close();
    return;
  }

  console.log('[backfill] DB:', DB_PATH);
  console.log('[backfill] Linked job pairs:', valid.length, dryRun ? '(dry-run)' : '');

  const counts = {};
  for (const t of TABLES) counts[t] = 0;

  for (const { semantic_id, canonical_id } of valid) {
    for (const table of TABLES) {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE job_id = ?`).get(semantic_id).n;
      if (n === 0) continue;
      counts[table] += n;
      if (dryRun) {
        console.log(`[backfill] would UPDATE ${table}: ${n} rows  ${semantic_id} → ${canonical_id}`);
      } else {
        const r = db.prepare(`UPDATE ${table} SET job_id = ? WHERE job_id = ?`).run(canonical_id, semantic_id);
        if (r.changes !== n) {
          console.warn('[backfill] unexpected changes', table, semantic_id, 'expected', n, 'got', r.changes);
        }
      }
    }
  }

  if (!dryRun) {
    const delGr = db.prepare(`
      DELETE FROM gate_results
      WHERE id IN (
        SELECT g.id FROM gate_results g
        INNER JOIN (
          SELECT job_id, gate, MAX(id) AS keep_id
          FROM gate_results
          GROUP BY job_id, gate
        ) x ON g.job_id = x.job_id AND g.gate = x.gate AND g.id != x.keep_id
      )
    `).run();
    console.log('[backfill] gate_results dedupe removed rows:', delGr.changes);

    const delPub = db.prepare(`
      DELETE FROM publish_results
      WHERE id IN (
        SELECT p.id FROM publish_results p
        INNER JOIN (
          SELECT job_id, platform, MAX(id) AS keep_id
          FROM publish_results
          GROUP BY job_id, platform
        ) x ON p.job_id = x.job_id AND p.platform = x.platform AND p.id != x.keep_id
      )
    `).run();
    console.log('[backfill] publish_results dedupe removed rows:', delPub.changes);

    let jsonPatched = 0;
    try {
      const info = db.prepare(`
        UPDATE gate_results
        SET result = json_set(result, '$.jobId', job_id)
        WHERE json_valid(result)
      `).run();
      jsonPatched = info.changes;
    } catch (e) {
      console.warn('[backfill] json_set on gate_results.result skipped:', e.message);
    }
    console.log('[backfill] gate_results JSON $.jobId aligned rows:', jsonPatched);
  } else {
    const dupGr = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT job_id, gate FROM gate_results GROUP BY job_id, gate HAVING COUNT(*) > 1
      )
    `).get().n;
    const dupPub = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT job_id, platform FROM publish_results GROUP BY job_id, platform HAVING COUNT(*) > 1
      )
    `).get().n;
    console.log('[backfill] dry-run: duplicate (job_id,gate) groups after move:', dupGr);
    console.log('[backfill] dry-run: duplicate (job_id,platform) groups after move:', dupPub);
  }

  console.log('[backfill] row counts touched per table:', counts);
  console.log(dryRun ? '[backfill] dry-run complete (no writes).' : '[backfill] done.');
  db.close();
}

main();
