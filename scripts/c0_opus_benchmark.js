'use strict';
/**
 * CPD-1235 — C0 localhost timing vs Opus (same Ep5 URL).
 * Compose-equivalent API path: validate → generate-clip-comp → hooks → assemble.
 * Does NOT publish or run Gate 5.
 *
 * Usage:
 *   node scripts/c0_opus_benchmark.js
 *   C0_BASE=http://localhost:3000 node scripts/c0_opus_benchmark.js
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { buildCompositionSpec, toGenerateClipCompBody } = require('../lib/composition_spec');

const BASE = process.env.C0_BASE || 'http://localhost:3000';
const OUT_DIR = path.join(__dirname, '../logs/opus_benchmark');
const EP5_URL = process.env.C0_BENCH_URL || 'https://www.youtube.com/watch?v=2mM9vHjz_LM';
const EP5_ID = '2mM9vHjz_LM';
const SEG_START = Number(process.env.C0_BENCH_START_SEC || 0);
const SEG_END = Number(process.env.C0_BENCH_END_SEC || 60);
const TIMEOUT_MS = parseInt(process.env.C0_BENCH_TIMEOUT_MS || '1800000', 10);

function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const data = body != null ? JSON.stringify(body) : '';
    const req = http.request(u, {
      method,
      headers: body != null
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
        : {},
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, ...JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, raw: d }); }
      });
    });
    req.on('error', reject);
    if (body != null) req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function pollJob(jobId, onStage) {
  const start = Date.now();
  let lastStage = '';
  while (Date.now() - start < TIMEOUT_MS) {
    const data = await api('GET', `/job/${encodeURIComponent(jobId)}`);
    const job = data.job || data;
    const stage = job?.stage || job?.status || '';
    if (stage && stage !== lastStage) {
      lastStage = stage;
      console.log(`  ${jobId} → ${stage}`);
      if (onStage) onStage(stage, job);
    }
    if (stage === 'failed' || job?.assemblyError) {
      throw new Error(job?.assemblyError || job?.error || 'job failed');
    }
    if (stage === 'hook_review') {
      let hooks = (job.clipHookTitles || []).filter((h) => String(h || '').trim());
      if (!hooks.length) {
        console.log(`  ${jobId} → regenerate-hooks (empty hook lines)`);
        const regen = await api('POST', `/job/${encodeURIComponent(jobId)}/regenerate-hooks`, {});
        if (!regen.ok) throw new Error(regen.error || 'regenerate-hooks failed');
        await sleep(5000);
        continue;
      }
      const resp = await api('POST', `/job/${encodeURIComponent(jobId)}/confirm-hooks`, {});
      if (!resp.ok) throw new Error(resp.error || 'confirm-hooks failed');
      console.log(`  ${jobId} → confirm-hooks (assembly started)`);
    }
    const out = job?.driveUrl || job?.finalUrl || job?.state?.savedOutputs?.driveUrl;
    if (out && ['assembled', 'awaiting_review', 'metadata_review'].includes(stage)) {
      return { job, stage, wallMs: Date.now() - start, outputUrl: out };
    }
    await sleep(3000);
  }
  throw new Error(`timeout waiting for assembled (${jobId})`);
}

function appendCsv(row) {
  const csvPath = path.join(OUT_DIR, 'benchmark.csv');
  const line = [
    row.test,
    row.project,
    row.source,
    row.wall_sec,
    row.clip_count,
    row.top_score,
    row.model,
  ].join(',') + '\n';
  fs.appendFileSync(csvPath, line);
}

async function main() {
  console.log('=== C0 Opus parity benchmark (localhost) ===');
  console.log(`Source: ${EP5_URL} [${SEG_START}s–${SEG_END}s]`);

  const health = await api('GET', '/health');
  if (health.status !== 200 && !health.ok) {
    throw new Error(`C0 not healthy at ${BASE}`);
  }

  const { spec, validation } = buildCompositionSpec({
    deliveryFormat: 'vod_segment',
    compCreativePreset: 'full_bleed',
    contentSource: 'news',
    platforms: ['youtube'],
    vodSegment: {
      vodUrl: EP5_URL,
      title: 'Twitch Soup Ep5 — CPD-1235 benchmark',
      streamer: 'ClipzWorld',
      duration_sec: 7200,
      start_sec: SEG_START,
      end_sec: SEG_END,
    },
  });
  if (!validation.ok) throw new Error(validation.errors.join('; '));

  const validateResp = await api('POST', '/composition/validate', {
    ...spec,
    clips: spec.clips,
    deliveryFormat: spec.deliveryFormat,
    compCreativePreset: spec.compCreativePreset,
    vodSegment: spec.vodSegment,
    contentSource: 'news',
  });
  if (!validateResp.validation?.ok && !validateResp.ok) {
    throw new Error(validateResp.validation?.errors?.join('; ') || validateResp.error || 'validate failed');
  }

  const dispatchBody = toGenerateClipCompBody(spec);
  const t0 = Date.now();
  const createResp = await api('POST', '/generate-clip-comp', dispatchBody);
  if (!createResp.ok || !createResp.jobId) {
    throw new Error(createResp.error || JSON.stringify(createResp).slice(0, 500));
  }
  const jobId = createResp.jobId;
  console.log(`Job created: ${jobId} (+${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const stages = [];
  const result = await pollJob(jobId, (stage) => stages.push({ stage, atSec: Math.round((Date.now() - t0) / 1000) }));
  const wallSec = Math.round((Date.now() - t0) / 1000);
  const job = result.job;
  const hookCount = (job.clipHookTitles || job.hookCandidates || []).filter(Boolean).length;

  const out = {
    benchmark: 'c0_localhost',
    jobId,
    source: EP5_ID,
    segment: `${SEG_START}-${SEG_END}`,
    wall_sec: wallSec,
    clip_count: 1,
    hook_count: hookCount,
    output_url: result.outputUrl,
    stages,
    contentType: spec.contentType,
    preset: spec.compCreativePreset,
    finishedAt: new Date().toISOString(),
  };

  const outPath = path.join(OUT_DIR, `c0_benchmark_${jobId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  appendCsv({
    test: 'c0_long',
    project: jobId,
    source: EP5_ID,
    wall_sec: wallSec,
    clip_count: 1,
    top_score: hookCount ? 'hooks' : 'n/a',
    model: 'full_bleed+bookends',
  });

  console.log(`\nDone in ${wallSec}s — hooks=${hookCount} — ${result.outputUrl}`);
  console.log(`Wrote ${outPath}`);
  console.log('=== C0 benchmark PASS ===');
}

main().catch((err) => {
  console.error('=== C0 benchmark FAIL ===', err.message);
  process.exit(1);
});
