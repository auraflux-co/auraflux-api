#!/usr/bin/env node
'use strict';
/**
 * Read-only A/V probe daemon — actually samples RTSP video frames + audio levels.
 * Does NOT modify grid config, restart ffmpeg, or POST control endpoints.
 *
 * Logs: logs/stream_av_probe.jsonl, logs/stream_av_probe_summary.md
 * Snapshots: logs/stream_probe_snapshots/q{N}_latest.jpg (on-air quad by default)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const REPO = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(REPO, '.env'), override: true });

const { probeQuadrantAv, overallAvLevel } = require('../lib/live_grid/av_probe');
const { computeStabilityTick, buildAgentMarkdown } = require('../lib/live_grid/stability_tracker');

const SIDECAR = (process.env.LIVE_SIDECAR_URL || `http://127.0.0.1:${process.env.LIVE_SIDECAR_PORT || 3001}`).replace(/\/$/, '');
const INTERVAL_MS = parseInt(process.env.STREAM_AV_PROBE_INTERVAL_MS || '60000', 10);
const LOG_PATH = process.env.STREAM_AV_PROBE_LOG || path.join(REPO, 'logs', 'stream_av_probe.jsonl');
const SUMMARY_PATH = path.join(REPO, 'logs', 'stream_av_probe_summary.md');
const STATE_PATH = path.join(REPO, 'logs', 'stream_av_probe_state.json');
const MONITOR_STATE_PATH = path.join(REPO, 'logs', 'live_monitor_state.json');
const MONITOR_SUMMARY_PATH = path.join(REPO, 'logs', 'live_monitor_summary.md');
const MONITOR_JSONL_PATH = path.join(REPO, 'logs', 'live_monitor.jsonl');
const HEALTH_JSONL_PATH = path.join(REPO, 'logs', 'stream_health.jsonl');
const SNAPSHOT_DIR = path.join(REPO, 'logs', 'stream_probe_snapshots');
const PROBE_ALL = /^true|1|on$/i.test(process.env.STREAM_AV_PROBE_ALL_QUADS || '');

let prevState = { quads: {} };

function logEvent(evt) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...evt })}\n`);
  const prefix = evt.level === 'critical' ? '🚨' : evt.level === 'warn' ? '⚠️' : '✅';
  console.log(`${prefix} [stream-av-probe] ${evt.msg || evt.event}`);
}

function getJson(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${SIDECAR}${urlPath}`, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (_) {
    return { quads: {} };
  }
}

function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(s, null, 2)}\n`);
}

function loadMonitorState() {
  try { return JSON.parse(fs.readFileSync(MONITOR_STATE_PATH, 'utf8')); } catch (_) {
    return { stableStreak: 0, lastGrid: null };
  }
}

function saveMonitorState(s) {
  fs.mkdirSync(path.dirname(MONITOR_STATE_PATH), { recursive: true });
  fs.writeFileSync(MONITOR_STATE_PATH, `${JSON.stringify(s, null, 2)}\n`);
}

function readLastHealthTick() {
  try {
    if (!fs.existsSync(HEALTH_JSONL_PATH)) return null;
    const lines = fs.readFileSync(HEALTH_JSONL_PATH, 'utf8').trim().split('\n').filter(Boolean);
    const last = lines[lines.length - 1];
    return last ? JSON.parse(last) : null;
  } catch (_) {
    return null;
  }
}

function writeLiveMonitor(stabilityState) {
  fs.mkdirSync(path.dirname(MONITOR_SUMMARY_PATH), { recursive: true });
  fs.writeFileSync(MONITOR_SUMMARY_PATH, `${buildAgentMarkdown(stabilityState)}\n`);
  fs.appendFileSync(MONITOR_JSONL_PATH, `${JSON.stringify({ event: 'live_monitor_tick', ...stabilityState })}\n`);
}

function writeSummary(data) {
  const vLevel = data.videoLevel || 'unknown';
  const aLevel = data.audioLevel || 'unknown';
  const lines = [
    `# Stream A/V probe — ${data.ts}`,
    '',
    '**Read-only sampling** — RTSP frame grab + audio level check. No fixes applied.',
    '**Scores reflect on-air quad only** — off-air tiles may be silent by design.',
    '',
    `**Video quality:** ${data.videoScore}/100 · **${vLevel}**`,
    `**Audio quality:** ${data.audioScore}/100 · **${aLevel}**`,
    `**On-air:** Q${data.onAirQuad || '—'} ${data.onAirLogin || ''}`,
    '',
    '## Video (frame samples)',
    ...(data.probes || []).map((p) => {
      const v = p.video;
      const snap = v.snapshotPath ? ` · [snapshot](${path.relative(REPO, v.snapshotPath)})` : '';
      return `- **Q${p.quad}** ${p.login || ''}: ${v.summary}${v.frozenStreak ? ` (frozen streak ${v.frozenStreak})` : ''}${snap}`;
    }),
    '',
    '## Audio (level samples)',
    ...(data.probes || []).map((p) => {
      const a = p.audio;
      const gaps = a.gapCount != null ? ` · ${a.gapCount} gaps` : '';
      return `- **Q${p.quad}** ${p.login || ''}: ${a.summary} (${a.sampleSec}s sample${gaps})`;
    }),
    '',
  ];
  if (data.videoIssues?.length) {
    lines.push('## Video issues', '', ...data.videoIssues.map((i) => `- ${i}`), '');
  }
  if (data.audioIssues?.length) {
    lines.push('## Audio issues (on-air)', '', ...data.audioIssues.map((i) => `- ${i}`), '');
  }
  if (data.allAudioIssues?.length) {
    lines.push('## Audio (all quads, diagnostic)', '', ...data.allAudioIssues.map((i) => `- ${i}`), '');
  }
  if (data.investigate?.length) {
    lines.push('## Investigate (no auto-fix)', '', ...data.investigate.map((i) => `- ${i}`), '');
  }
  fs.writeFileSync(SUMMARY_PATH, lines.join('\n'));
}

function scoreFromLevel(level) {
  if (level === 'good') return 100;
  if (level === 'warn') return 70;
  return 35;
}

async function tick() {
  let health;
  try {
    health = await getJson('/live-broadcast/health');
  } catch (e) {
    logEvent({ event: 'sidecar_unreachable', level: 'warn', msg: `sidecar unreachable: ${e.message}` });
    return;
  }

  if (!health.gridRunning) {
    logEvent({ event: 'grid_off', msg: 'grid not running — A/V probe idle' });
    writeSummary({
      ts: new Date().toISOString(),
      videoScore: 100,
      audioScore: 100,
      videoLevel: 'idle',
      audioLevel: 'idle',
      probes: [],
      msg: 'Grid offline',
    });
    return;
  }

  const st = await getJson('/live-grid/status');
  const onAirQuad = st.audio?.quadrant || 1;
  const quads = PROBE_ALL ? [1, 2, 3, 4] : [onAirQuad];
  const loginByQuad = {};
  for (const q of st.quadrants || []) {
    loginByQuad[q.quadrant] = q.login || q.displayName || null;
  }

  prevState = loadState();
  const probes = [];
  for (const quad of quads) {
    const prev = prevState.quads[String(quad)] || {};
    const p = await probeQuadrantAv({
      quad,
      login: loginByQuad[quad] || st.audio?.login,
      snapshotDir: quad === onAirQuad ? SNAPSHOT_DIR : null,
      prevHashes: prev,
    });
    prevState.quads[String(quad)] = p.state;
    probes.push({ quad, login: p.login, video: p.video, audio: p.audio });
  }
  saveState(prevState);

  const onAirProbe = probes.find((p) => p.quad === onAirQuad) || probes[0];
  const allVideoIssues = [];
  const allAudioIssues = [];
  for (const p of probes) {
    for (const iss of p.video.issues || []) {
      allVideoIssues.push(`Q${p.quad}: ${iss}`);
    }
    for (const iss of p.audio.issues || []) {
      allAudioIssues.push(`Q${p.quad}: ${iss}`);
    }
  }
  const onAirVideoIssues = (onAirProbe.video.issues || []).map((iss) => `Q${onAirQuad}: ${iss}`);
  const onAirAudioIssues = (onAirProbe.audio.issues || []).map((iss) => `Q${onAirQuad}: ${iss}`);
  const worstVideo = onAirProbe.video.level;
  const worstAudio = onAirProbe.audio.level;

  const investigate = [];

  if (onAirVideoIssues.some((i) => i.includes('frozen'))) {
    investigate.push('Frozen frame on on-air quad — verify source streamer is live (restart-risk if relay swap needed)');
  }
  if (onAirAudioIssues.some((i) => i.includes('silent'))) {
    investigate.push('Silent on-air audio — check if streamer muted or music guard stuck (manual pin may need sidecar POST — downtime risk)');
  }
  if (onAirAudioIssues.some((i) => /choppy|audio_gaps/i.test(i))) {
    investigate.push('Choppy on-air audio — relay UDP gaps or feeder restarts; check stream-health relay_churn (do not restart grid without approval)');
  }

  const payload = {
    event: 'av_probe_tick',
    level: overallAvLevel([{ video: onAirProbe.video, audio: onAirProbe.audio }]),
    msg: `probed Q${quads.join(',Q')} — on-air Q${onAirQuad} video ${worstVideo}, audio ${worstAudio}`,
    onAirQuad,
    onAirLogin: st.audio?.login,
    audioMode: st.audio?.mode,
    probes,
    videoIssues: onAirVideoIssues,
    audioIssues: onAirAudioIssues,
    allVideoIssues: PROBE_ALL ? allVideoIssues : undefined,
    allAudioIssues: PROBE_ALL ? allAudioIssues : undefined,
    investigate,
    videoScore: scoreFromLevel(worstVideo),
    audioScore: scoreFromLevel(worstAudio),
    videoLevel: worstVideo,
    audioLevel: worstAudio,
    watchUrl: st.broadcast?.watchUrl || null,
  };

  logEvent(payload);

  const healthTick = readLastHealthTick();
  const prevMonitor = loadMonitorState();
  const stabilityState = computeStabilityTick({
    prevState: prevMonitor,
    gridStatus: st,
    healthTick,
    avProbeTick: payload,
  });
  saveMonitorState(stabilityState);
  writeLiveMonitor(stabilityState);

  if (stabilityState.isStable && !prevMonitor?.isStable) {
    logEvent({
      event: 'stable',
      level: 'info',
      msg: `grid stable ${stabilityState.stableStreak} ticks — no tweaks needed (audio/roster changes only)`,
    });
  } else if (stabilityState.blockers?.length) {
    logEvent({
      event: 'unstable',
      level: 'warn',
      msg: `blockers: ${stabilityState.blockers.join(', ')}`,
    });
  } else if (stabilityState.gridChanges?.length) {
    logEvent({
      event: 'grid_change',
      level: 'info',
      msg: stabilityState.gridChanges.map((c) => c.type).join(', '),
    });
  }

  writeSummary({ ts: new Date().toISOString(), ...payload });
}

async function main() {
  prevState = loadState();
  logEvent({
    event: 'start',
    msg: `watching ${SIDECAR} every ${INTERVAL_MS}ms → ${SUMMARY_PATH} (allQuads=${PROBE_ALL})`,
  });
  await tick();
  setInterval(() => {
    tick().catch((e) => logEvent({ event: 'tick_error', level: 'critical', msg: e.message }));
  }, INTERVAL_MS);
}

main().catch((e) => {
  console.error('[stream-av-probe] fatal', e);
  process.exit(1);
});
