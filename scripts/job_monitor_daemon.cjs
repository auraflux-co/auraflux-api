#!/usr/bin/env node
/**
 * 24/7 pipeline job monitor — runs until SIGINT/SIGTERM.
 *
 * - Polls SQLite (same DB as the API) for active jobs — no "stable exit" unlike phase_a_gate_watch.
 * - De-duplicates script_* rows when a linked c0_* semantic row exists (script_job_id spine).
 * - On every gate/status fingerprint change: appends one JSON line to JOB_MONITOR_LOG.
 * - If a job is unchanged longer than JOB_MONITOR_STUCK_MS and not terminal: writes a stuck warning (once per stuck window).
 *
 * Env:
 *   JOB_MONITOR_INTERVAL_MS   — poll period (default 60000)
 *   JOB_MONITOR_MAX_AGE_MS    — ignore jobs older than this (default 7 days)
 *   JOB_MONITOR_MAX_ROWS      — max jobs per poll (default 200)
 *   JOB_MONITOR_STUCK_MS      — time without change before stuck warning (default 30 min)
 *   JOB_MONITOR_LOG           — jsonl path (default logs/job_monitor_events.jsonl)
 *   JOB_MONITOR_HEARTBEAT_MS  — stdout summary every N ms (default 300000 = 5 min)
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'cwn.db');
const GATE_ORDER = ['gate0', 'gate1', 'gate2', 'gate3a', 'gate3b', 'gate4', 'gate5'];

const INTERVAL_MS = parseInt(process.env.JOB_MONITOR_INTERVAL_MS || '60000', 10);
const MAX_AGE_MS = parseInt(process.env.JOB_MONITOR_MAX_AGE_MS || String(7 * 24 * 60 * 60 * 1000), 10);
const MAX_ROWS = parseInt(process.env.JOB_MONITOR_MAX_ROWS || '200', 10);
const STUCK_MS = parseInt(process.env.JOB_MONITOR_STUCK_MS || String(30 * 60 * 1000), 10);
const LOG_PATH = process.env.JOB_MONITOR_LOG || path.join(__dirname, '..', 'logs', 'job_monitor_events.jsonl');
const HEARTBEAT_MS = parseInt(process.env.JOB_MONITOR_HEARTBEAT_MS || String(5 * 60 * 1000), 10);

function summarizeGates(gateResults) {
  if (!gateResults || typeof gateResults !== 'object') return '';
  return GATE_ORDER.map((g) => {
    const r = gateResults[g];
    if (!r) return `${g}:-`;
    const o = r.outcome != null ? String(r.outcome).slice(0, 24) : '';
    const p = r.passed === true ? 'OK' : r.passed === false ? 'XX' : '?';
    return `${g}:${p}${o ? ':' + o : ''}`;
  }).join(' ');
}

function fingerprintFromSpec(spec) {
  if (!spec || typeof spec !== 'object') return 'no_spec';
  const st = spec.state?.status ?? '';
  const gr = spec.state?.gateResults || {};
  const g5 = gr.gate5;
  const g5done = g5 && g5.passed === true;
  const so = spec.state?.savedOutputs || {};
  const hasAssembled = !!(so.assembledPath || so.driveUrl);
  const qgc = spec.state?.automation?.qaGenerateConfirm;
  const qaGenFp = qgc
    ? `qaGen:${qgc.status || '-'}:${qgc.policyEnabled ? 'pol' : 'nopol'}`
    : 'qaGen:-';
  return [
    st,
    g5done ? 'gate5:done' : 'gate5:no',
    hasAssembled ? 'out:yes' : 'out:no',
    qaGenFp,
    summarizeGates(gr)
  ].join('|');
}

function isTerminal(spec, cardStage) {
  if (spec?.state?.gateResults?.gate5?.passed === true) return true;
  const st = spec?.state?.status;
  if (st === 'failed' || st === 'completed') return true;
  if (cardStage === 'stuck') return true;
  return false;
}

function loadDb() {
  const { getDb } = require(path.join(__dirname, '..', 'lib', 'db'));
  getDb();
  return require(path.join(__dirname, '..', 'lib', 'db'));
}

function selectCanonicalJobIds(db) {
  const Database = require('better-sqlite3');
  if (!fs.existsSync(DB_PATH)) return [];
  const raw = new Database(DB_PATH, { readonly: true });
  const cutoff = Date.now() - MAX_AGE_MS;
  try {
    const rows = raw
      .prepare(
        `
      SELECT id FROM jobs j
      WHERE j.updated_at > @cutoff
        AND NOT (
          j.id LIKE 'script_%'
          AND EXISTS (SELECT 1 FROM jobs c WHERE c.script_job_id = j.id)
        )
      ORDER BY j.updated_at DESC
      LIMIT @lim
    `
      )
      .all({ cutoff, lim: MAX_ROWS });
    const ids = rows.map((r) => r.id);
    // If link backfilled late, drop orphaned script_* rows that now have a c0 parent
    return ids.filter((id) => {
      if (!id.startsWith('script_')) return true;
      const sup = raw.prepare('SELECT 1 FROM jobs WHERE script_job_id = ? LIMIT 1').get(id);
      return !sup;
    });
  } finally {
    raw.close();
  }
}

function appendEvent(lineObj) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify(lineObj) + '\n', 'utf8');
}

function main() {
  const dbApi = loadDb();
  const { getJobBySpec, loadJob } = dbApi;

  /** @type {Map<string, { fp: string, at: number, lastStuckLine: number }>} */
  const state = new Map();

  let running = true;
  let lastHeartbeat = Date.now();
  let pollCount = 0;
  let transitionCount = 0;

  function shutdown() {
    running = false;
    console.log('\n[job-monitor] shutting down');
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(
    `[job-monitor] started interval=${INTERVAL_MS}ms maxAge=${MAX_AGE_MS}ms stuckWarn=${STUCK_MS}ms log=${LOG_PATH}`
  );

  function tick() {
    pollCount += 1;
    const ids = selectCanonicalJobIds();
    const now = Date.now();

    for (const jobId of ids) {
      let spec = null;
      try {
        spec = getJobBySpec(jobId);
      } catch (e) {
        appendEvent({
          type: 'error',
          t: new Date().toISOString(),
          jobId,
          message: e.message
        });
        continue;
      }

      const card = loadJob(jobId) || null;
      const stage = card?.stage || null;

      const fp = fingerprintFromSpec(spec);
      const term = isTerminal(spec, stage);

      const prev = state.get(jobId);
      if (!prev) {
        state.set(jobId, { fp, at: now, lastStuckLine: 0 });
        appendEvent({
          type: 'baseline',
          t: new Date().toISOString(),
          jobId,
          fingerprint: fp,
          stage,
          terminal: term
        });
        transitionCount += 1;
        continue;
      }

      if (prev.fp !== fp) {
        state.set(jobId, { fp, at: now, lastStuckLine: prev.lastStuckLine });
        appendEvent({
          type: 'transition',
          t: new Date().toISOString(),
          jobId,
          from: prev.fp,
          to: fp,
          stage,
          terminal: term
        });
        transitionCount += 1;
        continue;
      }

      if (!term && now - prev.at > STUCK_MS) {
        const due =
          !prev.lastStuckLine || now - prev.lastStuckLine > STUCK_MS;
        if (due) {
          appendEvent({
            type: 'stuck',
            t: new Date().toISOString(),
            jobId,
            fingerprint: fp,
            stage,
            unchangedMs: now - prev.at,
            message:
              'No state change since baseline/last transition — check HeyGen, assembly, or server logs'
          });
          state.set(jobId, { ...prev, lastStuckLine: now });
        }
      }
    }

    if (now - lastHeartbeat >= HEARTBEAT_MS) {
      lastHeartbeat = now;
      const active = ids.length;
      console.log(
        `[job-monitor] heartbeat polls=${pollCount} watched=${active} transitionsTotal=${transitionCount} log=${LOG_PATH}`
      );
      appendEvent({
        type: 'heartbeat',
        t: new Date().toISOString(),
        polls: pollCount,
        watched: active,
        transitionsTotal: transitionCount
      });
    }
  }

  try {
    tick();
  } catch (e) {
    console.error('[job-monitor] tick error', e);
  }
  const iv = setInterval(() => {
    try {
      tick();
    } catch (e) {
      console.error('[job-monitor] tick error', e);
    }
  }, INTERVAL_MS);

}

main();
