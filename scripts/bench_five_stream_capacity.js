#!/usr/bin/env node
'use strict';
/**
 * CPD-1063 — Off-air 5-stream encode capacity benchmark (steps 0–4).
 *
 * Usage:
 *   node scripts/bench_five_stream_capacity.js
 *   BENCH_STEPS=0,3 BENCH_SETTLE_SEC=120 node scripts/bench_five_stream_capacity.js
 *
 * Env:
 *   LIVE_SIDECAR_URL     — broadcast sidecar (default staging)
 *   BENCH_STEPS          — comma list, default 0,1,2,3,4
 *   BENCH_SETTLE_SEC     — wait after apply-step before sampling (default 90)
 *   BENCH_SAMPLE_SEC     — poll interval during sample window (default 15)
 *   BENCH_SAMPLE_TICKS   — samples per step (default 4)
 *   BENCH_DRY_RUN        — if 1, only GET encode-contract (no apply-step)
 *   RENDER_SERVICE_ID    — optional Render service for CPU metrics
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SIDECAR = (process.env.LIVE_SIDECAR_URL || 'https://auraflux-broadcast-staging.onrender.com').replace(/\/$/, '');
const STEPS = (process.env.BENCH_STEPS || '0,1,2,3,4').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
const SETTLE_MS = Math.max(30, parseInt(process.env.BENCH_SETTLE_SEC || '90', 10)) * 1000;
const SAMPLE_MS = Math.max(5, parseInt(process.env.BENCH_SAMPLE_SEC || '15', 10)) * 1000;
const TICKS = Math.max(1, parseInt(process.env.BENCH_SAMPLE_TICKS || '4', 10));
const DRY_RUN = String(process.env.BENCH_DRY_RUN || '').toLowerCase() === '1'
  || String(process.env.BENCH_DRY_RUN || '').toLowerCase() === 'true';
const LOG = path.join(__dirname, '..', 'logs', `bench_five_stream_${new Date().toISOString().slice(0, 10)}.jsonl`);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(row) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `${JSON.stringify(row)}\n`);
  console.log(JSON.stringify(row));
}

function localLoad() {
  const cores = Math.max(1, os.cpus().length);
  const load = os.loadavg()[0] / cores;
  return { loadPerCore: +load.toFixed(3), cores };
}

async function fetchStatus() {
  const { data } = await axios.get(`${SIDECAR}/live-grid/status`, { timeout: 30_000 });
  return data;
}

async function fetchEncodeContract() {
  const { data } = await axios.get(`${SIDECAR}/live-grid/encode-contract`, { timeout: 30_000 });
  return data;
}

async function applyStep(step) {
  const { data } = await axios.post(`${SIDECAR}/live-grid/benchmark/apply-step`, { step }, { timeout: 120_000 });
  return data;
}

function passVerdict(row) {
  const hints = row.encodeContract?.passHints || {};
  const loadOk = row.loadPerCore == null || row.loadPerCore < 0.85;
  const restarts = row.soloRestartsTotal ?? 0;
  const restartOk = restarts <= 2;
  const encoders = row.encodeContract?.totals?.encoderCount ?? 0;
  const runningOk = encoders >= (row.expectedEncoders ?? 0);
  const pass = loadOk && restartOk && runningOk;
  return {
    pass,
    loadOk,
    restartOk,
    runningOk,
    youtube1080p: !!hints.allMeetYoutube1080p,
    uniformSolos: !!hints.allSolosUniform,
  };
}

function soloRestartsTotal(status) {
  const solos = status?.soloStreams?.streams || status?.soloPublishers?.streams || [];
  if (Array.isArray(solos)) {
    return solos.reduce((n, s) => n + (s?.restarts || 0), 0);
  }
  return null;
}

async function sampleStep(step, stepMeta) {
  const expectedEncoders = stepMeta?.mainEncode
    ? 1 + (stepMeta.soloSeats?.length || 0)
    : (stepMeta.soloSeats?.length || 0);

  console.log(`\n[bench] step ${step} (${stepMeta?.label}) — settle ${SETTLE_MS / 1000}s…`);
  await sleep(SETTLE_MS);

  const samples = [];
  for (let i = 0; i < TICKS; i++) {
    const status = await fetchStatus();
    const contract = status.encodeContract || (await fetchEncodeContract()).contract;
    const load = localLoad();
    const row = {
      ts: new Date().toISOString(),
      step,
      label: stepMeta?.label,
      tick: i + 1,
      loadPerCore: load.loadPerCore,
      expectedEncoders,
      encodeContract: contract,
      mainRunning: status.master?.running ?? status.encode?.running,
      soloRestartsTotal: soloRestartsTotal(status),
      activeVideoBitrateK: contract?.totals?.activeVideoBitrateK,
    };
    row.verdict = passVerdict(row);
    samples.push(row);
    log(row);
    if (i + 1 < TICKS) await sleep(SAMPLE_MS);
  }

  const last = samples[samples.length - 1];
  const maxLoad = Math.max(...samples.map((s) => s.loadPerCore || 0));
  const summary = {
    ts: new Date().toISOString(),
    step,
    label: stepMeta?.label,
    type: 'step_summary',
    samples: samples.length,
    maxLoadPerCore: +maxLoad.toFixed(3),
    pass: samples.every((s) => s.verdict?.pass),
    lastVerdict: last?.verdict,
    activeVideoBitrateK: last?.activeVideoBitrateK,
  };
  log(summary);
  return summary;
}

async function main() {
  console.log(`[bench] sidecar=${SIDECAR} steps=${STEPS.join(',')} dryRun=${DRY_RUN}`);
  console.log(`[bench] log → ${LOG}`);

  const meta = await fetchEncodeContract();
  if (!meta?.steps) {
    throw new Error('encode-contract endpoint unavailable — deploy CPD-1063 code first');
  }

  if (DRY_RUN) {
    log({ ts: new Date().toISOString(), type: 'dry_run', contract: meta.contract, steps: meta.steps });
    return;
  }

  const status = await fetchStatus();
  if (!status?.running) {
    throw new Error('Live grid not running — start grid off-air before benchmark');
  }

  const summaries = [];
  for (const step of STEPS) {
    const stepMeta = meta.steps[String(step)] || meta.steps[step];
    const applied = await applyStep(step);
    if (!applied?.ok) throw new Error(`apply-step ${step} failed: ${JSON.stringify(applied)}`);
    log({ ts: new Date().toISOString(), type: 'applied', step, applied });
    summaries.push(await sampleStep(step, stepMeta || applied));
  }

  log({
    ts: new Date().toISOString(),
    type: 'run_complete',
    steps: STEPS,
    allPass: summaries.every((s) => s.pass),
    summaries,
  });
}

main().catch((e) => {
  console.error('[bench] failed:', e.response?.data || e.message);
  process.exit(1);
});
