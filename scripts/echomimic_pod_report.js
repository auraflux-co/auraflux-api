#!/usr/bin/env node
'use strict';
/**
 * EchoMimic pod failure + latency report.
 *
 * Reads logs/echomimic_pod_metrics.jsonl plus sweep/gate artifacts.
 * Run after avatar jobs or on demand:
 *   node scripts/echomimic_pod_report.js
 *   node scripts/echomimic_pod_report.js --days 7
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const METRICS = path.join(ROOT, 'logs', 'echomimic_pod_metrics.jsonl');
const OUT = path.join(ROOT, 'logs', 'echomimic_pod_report.md');

const days = (() => {
  const i = process.argv.indexOf('--days');
  return i >= 0 ? parseInt(process.argv[i + 1], 10) : 14;
})();

// $/hr on-demand — update when quoting alternatives; speed mult vs 4090 baseline TBD until benchmarked
const PROVIDERS = [
  { id: 'runpod_4090', label: 'RunPod RTX 4090 (current)', usdPerHr: 0.34, speedMult: 1.0, note: 'Measured baseline' },
  { id: 'runpod_l40s', label: 'RunPod L40S', usdPerHr: 0.79, speedMult: 1.0, note: 'Same class — estimate until benchmark' },
  { id: 'lambda_4090', label: 'Lambda Labs 4090', usdPerHr: 0.55, speedMult: 1.0, note: 'Estimate — run same gate script to measure' },
  { id: 'aws_g5_a10g', label: 'AWS g5 A10G', usdPerHr: 1.05, speedMult: 0.95, note: 'Often ~same infer; ~3× cost; better availability' },
  { id: 'coreweave_h100', label: 'CoreWeave H100', usdPerHr: 2.49, speedMult: 0.7, note: 'Overkill for Flash 1.3B — faster but expensive' }
];

function loadJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function sinceCutoff(iso, d) {
  const t = new Date(iso).getTime();
  return t >= Date.now() - d * 86400000;
}

function pct(n, d) {
  if (!d) return '—';
  return `${((n / d) * 100).toFixed(1)}%`;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function loadSweepStats() {
  const p = path.join(ROOT, 'output', 'avatar_mouth_sweep', 'results.json');
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const ok = (j.variants || []).length;
    const err = (j.errors || []).length;
    const times = (j.variants || []).map((v) => v.renderSec).filter(Boolean);
    return { ok, err, medianRenderSec: median(times), source: 'mouth_sweep' };
  } catch { return null; }
}

function loadGateStats() {
  const p = path.join(ROOT, 'output', 'avatar_clone_gate', 'manifest.json');
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { renderSec: j.renderSec, completedAt: j.completedAt, source: 'clone_gate' };
  } catch { return null; }
}

function main() {
  const rows = loadJsonl(METRICS).filter((r) => sinceCutoff(r.ts, days));
  const byEvent = {};
  for (const r of rows) {
    byEvent[r.event] = (byEvent[r.event] || 0) + 1;
  }

  const wakeStarts = rows.filter((r) => r.event === 'pod_wake_start').length;
  const wakeFails = rows.filter((r) => r.event === 'pod_wake_fail').length;
  const startFails = rows.filter((r) => r.event === 'pod_start_failed').length;
  const creates = rows.filter((r) => r.event === 'pod_create').length;
  const renderOk = rows.filter((r) => r.event === 'render_ok').length;
  const renderFail = rows.filter((r) => r.event === 'render_fail').length;

  const wakeMs = rows.filter((r) => r.event === 'pod_wake_ok').map((r) => r.durationMs).filter(Boolean);
  const renderMs = rows.filter((r) => r.event === 'render_ok').map((r) => r.durationMs).filter(Boolean);
  const inferSec = rows.filter((r) => r.event === 'render_ok').map((r) => r.renderSeconds).filter(Boolean);

  const failErrors = {};
  for (const r of rows.filter((x) => x.event === 'render_fail' || x.event === 'pod_wake_fail' || x.event === 'pod_start_failed')) {
    const k = r.error || r.event;
    failErrors[k] = (failErrors[k] || 0) + 1;
  }

  const gpuTypes = {};
  for (const r of rows.filter((x) => x.gpuType)) {
    gpuTypes[r.gpuType] = (gpuTypes[r.gpuType] || 0) + 1;
  }

  const sweep = loadSweepStats();
  const gate = loadGateStats();

  const baselineRenderSec = median(inferSec) || sweep?.medianRenderSec || gate?.renderSec || 126;
  const baselineWakeSec = (median(wakeMs) || 180000) / 1000;

  const lines = [];
  lines.push(`# EchoMimic Pod Report`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Window: last ${days} days`);
  lines.push('');
  lines.push('## Reliability');
  lines.push('');
  lines.push(`| Metric | Count | Rate |`);
  lines.push(`|--------|------:|-----:|`);
  lines.push(`| Pod wake attempts | ${wakeStarts} | |`);
  lines.push(`| Pod wake failures | ${wakeFails} | ${pct(wakeFails, wakeStarts)} |`);
  lines.push(`| GPU start failures (→ recreate pod) | ${startFails} | ${pct(startFails, wakeStarts)} |`);
  lines.push(`| Fresh pods created | ${creates} | |`);
  lines.push(`| Render OK | ${renderOk} | ${pct(renderOk, renderOk + renderFail)} |`);
  lines.push(`| Render fail | ${renderFail} | ${pct(renderFail, renderOk + renderFail)} |`);
  if (sweep) {
    lines.push(`| Mouth sweep OK (artifact) | ${sweep.ok} | |`);
    lines.push(`| Mouth sweep fail (artifact) | ${sweep.err} | ${pct(sweep.err, sweep.ok + sweep.err)} |`);
  }
  lines.push('');
  if (Object.keys(failErrors).length) {
    lines.push('### Top errors');
    lines.push('');
    for (const [err, n] of Object.entries(failErrors).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      lines.push(`- **${n}×** \`${err.slice(0, 120)}\``);
    }
    lines.push('');
  }
  if (Object.keys(gpuTypes).length) {
    lines.push('### GPU types seen');
    lines.push('');
    for (const [g, n] of Object.entries(gpuTypes).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${g}: ${n} events`);
    }
    lines.push('');
  }
  lines.push('## Latency (RunPod baseline)');
  lines.push('');
  lines.push(`| Metric | p50 |`);
  lines.push(`|--------|----:|`);
  lines.push(`| Pod wake (incl. health) | ${(baselineWakeSec).toFixed(0)}s |`);
  lines.push(`| Render wall clock / window | ${(median(renderMs) / 1000 || baselineRenderSec).toFixed(1)}s |`);
  lines.push(`| GPU infer (worker render_seconds) | ${baselineRenderSec.toFixed(1)}s |`);
  lines.push('');
  lines.push('## Cost / speed vs alternatives (estimates)');
  lines.push('');
  lines.push(`Per ~2.5s clip at ${baselineRenderSec.toFixed(0)}s GPU + ${baselineWakeSec.toFixed(0)}s wake amortized over 7 windows:`);
  lines.push('');
  lines.push('| Provider | $/hr | Est. speed vs 4090 | Est. cost / 7-scene job | Notes |');
  lines.push('|----------|-----:|-------------------:|------------------------:|-------|');
  const jobGpuSec = baselineRenderSec * 7 + baselineWakeSec;
  for (const p of PROVIDERS) {
    const jobSec = jobGpuSec * p.speedMult;
    const cost = (jobSec / 3600) * p.usdPerHr;
    lines.push(`| ${p.label} | $${p.usdPerHr.toFixed(2)} | ${p.speedMult === 1 ? '1.0× (baseline)' : p.speedMult + '×'} | $${cost.toFixed(2)} | ${p.note} |`);
  }
  lines.push('');
  lines.push('> **Speed mults are placeholders** until the same `avatar_clone_gate.js` run completes on an alternative provider. Availability (start failures) is the main RunPod pain today.');
  lines.push('');
  lines.push('## Migration trigger (suggested)');
  lines.push('');
  lines.push('- **Stay on RunPod** if: render fail rate < 5% and start fail rate < 10% over 7 days');
  lines.push('- **Spike Lambda/CoreWeave** if: start fail rate > 20% OR repeated wrong-GPU provisions (5090)');
  lines.push('- **AWS g5** if: availability still blocks production jobs after specialist clouds tried');
  lines.push('');
  lines.push(`Raw metrics: \`logs/echomimic_pod_metrics.jsonl\``);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n'));
  console.log(lines.join('\n'));
  console.log(`\n[report] written → ${OUT}`);
}

main();
