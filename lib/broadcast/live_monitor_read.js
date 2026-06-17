'use strict';

const fs = require('fs');
const path = require('path');
const { readStreamHealthReport } = require('./stream_health_read');
const { readAvProbeReport } = require('./av_probe_read');
const { buildAgentMarkdown } = require('../live_grid/stability_tracker');

const REPO_ROOT = path.join(__dirname, '..', '..');
const STATE_PATH = path.join(REPO_ROOT, 'logs', 'live_monitor_state.json');
const SUMMARY_PATH = path.join(REPO_ROOT, 'logs', 'live_monitor_summary.md');
const JSONL_PATH = path.join(REPO_ROOT, 'logs', 'live_monitor.jsonl');

function readLiveMonitorReport() {
  let state = null;
  let summaryMtime = null;
  let markdown = null;

  try {
    if (fs.existsSync(STATE_PATH)) {
      state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch (_) {}

  try {
    if (fs.existsSync(SUMMARY_PATH)) {
      const stat = fs.statSync(SUMMARY_PATH);
      markdown = fs.readFileSync(SUMMARY_PATH, 'utf8');
      summaryMtime = stat.mtime.toISOString();
    }
  } catch (_) {}

  if (!markdown && state) {
    markdown = buildAgentMarkdown(state);
  }

  const streamHealth = readStreamHealthReport();
  const avProbe = readAvProbeReport();

  return {
    ok: true,
    summaryPath: 'logs/live_monitor_summary.md',
    summaryMtime,
    markdown: markdown || '# Live monitor\n\nNo report yet. Start pm2 `stream-av-probe` (and `stream-health`) while grid is live.',
    updatedAt: state?.ts || summaryMtime || avProbe.updatedAt || streamHealth.updatedAt || null,
    level: state?.level ?? null,
    isStable: state?.isStable ?? false,
    stableStreak: state?.stableStreak ?? 0,
    stableTicksRequired: state?.stableTicksRequired ?? 10,
    gridChanges: state?.gridChanges ?? [],
    blockers: state?.blockers ?? [],
    baselineHealth: state?.baselineHealth ?? [],
    actionableHealth: state?.actionableHealth ?? [],
    grid: state?.grid ?? null,
    av: state?.av ?? {
      videoLevel: avProbe.videoLevel,
      audioLevel: avProbe.audioLevel,
      videoScore: avProbe.videoScore,
      audioScore: avProbe.audioScore,
      videoIssues: avProbe.videoIssues,
      audioIssues: avProbe.audioIssues,
    },
    pipeline: state?.pipeline ?? null,
    watchUrl: state?.watchUrl ?? avProbe.watchUrl ?? null,
    streamHealth: {
      score: streamHealth.score,
      viewerScore: streamHealth.viewerScore,
      level: streamHealth.level,
      issues: streamHealth.issues,
      viewerIssues: streamHealth.viewerIssues,
      updatedAt: streamHealth.updatedAt,
    },
    avProbe: {
      videoLevel: avProbe.videoLevel,
      audioLevel: avProbe.audioLevel,
      snapshots: avProbe.snapshots,
      updatedAt: avProbe.updatedAt,
    },
    jsonlPath: 'logs/live_monitor.jsonl',
  };
}

module.exports = { readLiveMonitorReport, STATE_PATH, SUMMARY_PATH, JSONL_PATH };
