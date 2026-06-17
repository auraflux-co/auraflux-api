'use strict';
/**
 * Read stream health daemon output for dashboard / API.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SUMMARY_PATH = path.join(REPO_ROOT, 'logs', 'stream_health_summary.md');
const JSONL_PATH = path.join(REPO_ROOT, 'logs', 'stream_health.jsonl');

function readStreamHealthReport() {
  let markdown = null;
  let summaryExists = false;
  let summaryMtime = null;
  try {
    const stat = fs.statSync(SUMMARY_PATH);
    markdown = fs.readFileSync(SUMMARY_PATH, 'utf8');
    summaryExists = true;
    summaryMtime = stat.mtime.toISOString();
  } catch (_) {}

  let tick = null;
  try {
    if (fs.existsSync(JSONL_PATH)) {
      const lines = fs.readFileSync(JSONL_PATH, 'utf8').trim().split('\n').filter(Boolean);
      const last = lines[lines.length - 1];
      if (last) tick = JSON.parse(last);
    }
  } catch (_) {}

  return {
    ok: true,
    summaryExists,
    summaryPath: 'logs/stream_health_summary.md',
    summaryMtime,
    markdown: markdown || '# Stream health\n\nNo report yet. Start pm2 process `stream-health` if the grid is live.',
    updatedAt: tick?.ts || summaryMtime || null,
    score: tick?.score ?? null,
    level: tick?.level || (tick?.event === 'grid_off' ? 'info' : 'unknown'),
    viewerScore: tick?.viewerScore ?? null,
    viewerLevel: tick?.viewerLevel ?? null,
    viewerSummary: tick?.viewerSummary || tick?.msg || null,
    viewerSeeing: tick?.viewerSeeing || [],
    viewerIssues: tick?.viewerIssues || [],
    resolutions: tick?.resolutions || [],
    profile: tick?.profile || null,
    pipeline: tick?.pipeline || null,
    audio: tick?.audio || null,
    msg: tick?.msg || null,
    issues: tick?.issues || [],
    actions: tick?.actions || [],
    encode: tick?.encode || null,
    masterCpu: tick?.masterCpu ?? null,
    masterUptimeSec: tick?.masterUptimeSec ?? null,
    masterRestarts: tick?.masterRestarts ?? null,
    relayRestarts: tick?.relayRestarts || null,
    relayChurn: tick?.relayChurn || null,
    youtube: tick?.youtube || null,
    quads: tick?.quads || null,
  };
}

module.exports = { readStreamHealthReport };
