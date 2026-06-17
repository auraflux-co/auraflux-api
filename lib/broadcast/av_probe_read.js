'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SUMMARY_PATH = path.join(REPO_ROOT, 'logs', 'stream_av_probe_summary.md');
const JSONL_PATH = path.join(REPO_ROOT, 'logs', 'stream_av_probe.jsonl');
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'logs', 'stream_probe_snapshots');

function readAvProbeReport() {
  let markdown = null;
  let summaryMtime = null;
  try {
    const stat = fs.statSync(SUMMARY_PATH);
    markdown = fs.readFileSync(SUMMARY_PATH, 'utf8');
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

  const snapshots = [];
  try {
    if (fs.existsSync(SNAPSHOT_DIR)) {
      for (const f of fs.readdirSync(SNAPSHOT_DIR).filter((n) => n.endsWith('.jpg')).sort()) {
        snapshots.push({
          name: f,
          path: `logs/stream_probe_snapshots/${f}`,
          mtime: fs.statSync(path.join(SNAPSHOT_DIR, f)).mtime.toISOString(),
        });
      }
    }
  } catch (_) {}

  return {
    ok: true,
    summaryPath: 'logs/stream_av_probe_summary.md',
    summaryMtime,
    markdown: markdown || '# Stream A/V probe\n\nNo report yet. Start pm2 process `stream-av-probe` while grid is live.',
    updatedAt: tick?.ts || summaryMtime || null,
    videoScore: tick?.videoScore ?? null,
    audioScore: tick?.audioScore ?? null,
    videoLevel: tick?.videoLevel ?? null,
    audioLevel: tick?.audioLevel ?? null,
    onAirQuad: tick?.onAirQuad ?? null,
    onAirLogin: tick?.onAirLogin ?? null,
    audioMode: tick?.audioMode ?? null,
    watchUrl: tick?.watchUrl ?? null,
    probes: tick?.probes ?? null,
    videoIssues: tick?.videoIssues ?? [],
    audioIssues: tick?.audioIssues ?? [],
    investigate: tick?.investigate ?? [],
    snapshots,
  };
}

module.exports = { readAvProbeReport };
