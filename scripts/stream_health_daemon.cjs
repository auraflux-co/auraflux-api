#!/usr/bin/env node
'use strict';
/**
 * Stream health watchdog — quality-focused monitoring for Live Grid.
 * Logs JSONL + human-readable logs/stream_health_summary.md every tick.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const REPO = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(REPO, '.env'), override: true });

const {
  lockedProfile,
  ffmpegSnapshot,
  buildViewerExperience,
} = require('../lib/live_grid/health_metrics');

const SIDECAR = (process.env.LIVE_SIDECAR_URL || `http://127.0.0.1:${process.env.LIVE_SIDECAR_PORT || 3001}`).replace(/\/$/, '');
const INTERVAL_MS = parseInt(process.env.STREAM_HEALTH_INTERVAL_MS || '30000', 10);
const LOG_PATH = process.env.STREAM_HEALTH_LOG || path.join(REPO, 'logs', 'stream_health.jsonl');
const SUMMARY_PATH = path.join(REPO, 'logs', 'stream_health_summary.md');
const SIDECAR_LOG = path.join(REPO, 'logs', 'broadcast_sidecar.log');
const STATE_PATH = path.join(REPO, 'logs', 'stream_health_state.json');

const TARGET_FPS = parseInt(process.env.LIVE_GRID_FPS || '30', 10);
const TARGET_K = parseInt(process.env.LIVE_GRID_BITRATE_K || '9000', 10);
const MAX_RELAY_RESTARTS = parseInt(process.env.STREAM_HEALTH_MAX_RELAY_RESTARTS || '8', 10);
const MIN_MASTER_UPTIME_SEC = parseInt(process.env.STREAM_HEALTH_MIN_MASTER_UPTIME_SEC || '90', 10);

let prevRelayRestarts = [0, 0, 0, 0];
let prevGridUptime = 0;
let encodeBelowTargetStreak = 0;
let sidecarLogOffset = 0;

function logEvent(evt) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, `${JSON.stringify({ ts: new Date().toISOString(), ...evt })}\n`);
  const level = evt.level || 'info';
  const prefix = level === 'critical' ? '🚨' : level === 'warn' ? '⚠️' : '✅';
  console.log(`${prefix} [stream-health] ${evt.msg || evt.event}`);
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

function postJson(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${SIDECAR}${urlPath}`, { method: 'POST', timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (_) {
    return { sidecarLogOffset: 0 };
  }
}

function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(s, null, 2)}\n`);
}

async function syncRelayBaselineFromSidecar() {
  try {
    const st = await getJson('/live-grid/status');
    if (st?.relays?.length) {
      prevRelayRestarts = st.relays.map((r) => r.restarts || 0);
    }
    if (st?.uptimeSec) prevGridUptime = st.uptimeSec;
  } catch (_) { /* first tick will align */ }
}

function scanSidecarLog() {
  const hits = [];
  if (!fs.existsSync(SIDECAR_LOG)) return hits;
  const stat = fs.statSync(SIDECAR_LOG);
  if (sidecarLogOffset > stat.size) sidecarLogOffset = 0;
  const buf = Buffer.alloc(stat.size - sidecarLogOffset);
  const fd = fs.openSync(SIDECAR_LOG, 'r');
  fs.readSync(fd, buf, 0, buf.length, sidecarLogOffset);
  fs.closeSync(fd);
  sidecarLogOffset = stat.size;
  const chunk = buf.toString('utf8');
  const patterns = [
    { re: /lag of (\d+\.?\d*)s/i, tag: 'ffmpeg_lag' },
    { re: /master exited/i, tag: 'master_exit' },
    { re: /master restart/i, tag: 'master_restart' },
    { re: /Invalid DTS/i, tag: 'dts_error' },
    { re: /Failed reading RTSP/i, tag: 'rtsp_eof' },
    { re: /relay exited/i, tag: 'relay_exit' },
  ];
  for (const line of chunk.split('\n')) {
    for (const { re, tag } of patterns) {
      const m = line.match(re);
      if (m) hits.push({ tag, line: line.trim().slice(0, 200), lagSec: m[1] ? Number(m[1]) : null });
    }
  }
  return hits;
}

async function probeQuads() {
  const out = [];
  for (let q = 0; q < 4; q++) {
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error', '-rtsp_transport', 'tcp', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate,codec_name',
        '-of', 'csv=p=0', `rtsp://localhost:8554/quad${q + 1}`,
      ], { timeout: 8000 });
      const parts = String(stdout).trim().split(',');
      out.push({ quad: q + 1, ok: true, codec: parts[0], w: parts[1], h: parts[2], fps: parts[3] });
    } catch (e) {
      out.push({ quad: q + 1, ok: false, error: e.message.slice(0, 80) });
    }
  }
  return out;
}

async function masterCpu() {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-lf', 'ffmpeg.*live2'], { timeout: 3000 });
    const line = String(stdout).split('\n')[0] || '';
    const pid = parseInt(line.trim().split(/\s+/)[0], 10);
    if (!pid) return null;
    const { stdout: ps } = await execFileAsync('ps', ['-o', '%cpu=', '-p', String(pid)], { timeout: 3000 });
    return { pid, cpu: parseFloat(String(ps).trim()) };
  } catch (_) {
    return null;
  }
}

function writeSummary(data) {
  const lines = [
    `# Stream health — ${data.ts}`,
    '',
    `**Uptime score:** ${data.score}/100 · **${data.level}**`,
    `**Viewer experience:** ${data.viewerScore}/100 · **${data.viewerLevel}**`,
    '',
    data.viewerSummary || data.msg,
    '',
    '## What you are likely seeing',
    ...(data.viewerSeeing || []).map((l) => `- ${l}`),
    '',
    '## Locked profile (.env)',
    `- Output ${data.profile?.output} · cells ${data.profile?.cell} · ${data.encode?.fps || data.profile?.fps}fps · ${data.encode?.bitrateK || data.profile?.bitrateK}k`,
    `- Relay: ${data.profile?.relayTranscode ? `transcode ${data.profile?.relayScale} @ ${data.profile?.relayBitrateK || '?'}k` : 'copy'}`,
    `- Twitch ingest: ${data.profile?.twitchQuality} · music guard: ${data.profile?.musicGuard ? 'on' : 'off'}`,
    '',
    '## Live pipeline (detected now)',
    `- Output ${data.pipeline?.detectedOutput} · cells ${data.pipeline?.detectedCell} · pad-only: ${data.pipeline?.padOnly ? 'yes' : 'no'}`,
    `- Master CPU ${data.masterCpu ?? 'n/a'}% · total ffmpeg ${data.pipeline?.totalFfmpegCpu ?? 'n/a'}%`,
    `- Relays: ${data.pipeline?.relayTranscodeCount ?? 0}/4 transcoding · audio Q${data.audio?.quadrant || '—'} ${data.audio?.login || ''}`,
    '',
    '## Encode',
    `- ${data.encode?.fps}fps · ${data.encode?.bitrateK}k · master up ${data.masterUptimeSec}s · restarts ${data.masterRestarts}`,
    data.warmupRemaining > 0 ? `- Warmup: encoder stabilizing (~${data.warmupRemaining}s left)` : '',
    '',
    '## YouTube',
    `- ${data.youtube?.lifeCycleStatus || 'unknown'} · live=${data.youtube?.liveOnYouTube} · stale=${data.youtube?.staleLocal}`,
    '',
    '## Relays',
    `- restarts: ${JSON.stringify(data.relayRestarts)} · churn this tick: ${JSON.stringify(data.relayChurn)}`,
    '',
    '## Quadrants (RTSP source probe)',
    ...data.quads.map((q) => q.ok
      ? `- Q${q.quad}: ${q.w}x${q.h} ${q.fps} ${q.codec}`
      : `- Q${q.quad}: **FAIL** ${q.error}`),
    '',
  ];
  if (data.resolutions?.length) {
    lines.push('## Fix paths (apply when grid is OFF unless noted)', '');
    for (const r of data.resolutions) {
      lines.push(`- **${r.key}** — ${r.text}`);
    }
    lines.push('');
  }
  if (data.logHits?.length) {
    lines.push('## Recent sidecar errors (since last tick)', '');
    for (const h of data.logHits.slice(-12)) {
      lines.push(`- **${h.tag}** ${h.lagSec ? `(lag ${h.lagSec}s) ` : ''}${h.line}`);
    }
    lines.push('');
  }
  if (data.issues?.length) {
    lines.push('## Issues', '', data.issues.map((i) => `- ${i}`).join('\n'), '');
  }
  if (data.actions?.length) {
    lines.push('## Actions taken', '', data.actions.map((a) => `- ${a}`).join('\n'), '');
  }
  fs.writeFileSync(SUMMARY_PATH, lines.join('\n'));
}

async function tick() {
  const health = await getJson('/live-broadcast/health');
  if (!health.gridRunning) {
    logEvent({ event: 'grid_off', msg: 'grid not running — idle' });
    writeSummary({ ts: new Date().toISOString(), level: 'info', score: 100, msg: 'Grid offline', issues: [], actions: [], quads: [], encode: {}, youtube: {}, relayRestarts: [], relayChurn: [], masterUptimeSec: 0, masterRestarts: 0 });
    return;
  }

  const st = await getJson('/live-grid/status');
  const enc = st.master?.encode || {};
  const issues = [];
  const actions = [];
  let score = 100;

  const masterUp = st.master?.uptimeSec || 0;
  const masterRestarts = st.master?.restarts || 0;
  const gridUp = st.uptimeSec || 0;

  if (st.youtube?.staleLocal) { issues.push('youtube_stale_local'); score -= 40; }
  if (st.youtube?.liveOnYouTube === false) { issues.push('youtube_not_live'); score -= 50; }
  if (!st.master?.running) { issues.push('master_down'); score -= 60; }

  let warmupRemaining = 0;
  if (masterUp < MIN_MASTER_UPTIME_SEC) {
    warmupRemaining = MIN_MASTER_UPTIME_SEC - masterUp;
    // Light score nudge only — not a fault once relays are stable
    if (masterUp < 30) score -= 10;
    else if (masterUp < 60) score -= 5;
  }
  if (gridUp < prevGridUptime) {
    issues.push('grid_session_reset');
    score -= 20;
  }
  prevGridUptime = gridUp;

  const relayRestarts = (st.relays || []).map((r) => r.restarts || 0);
  const relayChurn = relayRestarts.map((n, i) => n - (prevRelayRestarts[i] || 0));
  prevRelayRestarts = [...relayRestarts];
  const maxRelay = Math.max(0, ...relayRestarts);
  const churnSum = relayChurn.reduce((a, b) => a + b, 0);
  if (maxRelay >= MAX_RELAY_RESTARTS) { issues.push(`relay_restarts_high:${maxRelay}`); score -= 15; }
  if (churnSum >= 2) { issues.push(`relay_churn_tick:${churnSum}`); score -= 10; }
  if (masterRestarts > 0) { issues.push(`master_restarts:${masterRestarts}`); score -= 20; }

  const logHits = scanSidecarLog();
  for (const h of logHits) {
    if (h.tag === 'ffmpeg_lag' && h.lagSec > 3) {
      issues.push(`ffmpeg_decode_lag:${h.lagSec}s`);
      score -= 25;
    }
    if (h.tag === 'master_exit' || h.tag === 'master_restart') score -= 15;
    if (h.tag === 'dts_error') { issues.push('dts_errors'); score -= 10; }
  }

  const fpsLow = enc.fps && enc.fps < TARGET_FPS;
  const kLow = enc.bitrateK && enc.bitrateK < TARGET_K;
  const autoReload = String(process.env.STREAM_HEALTH_AUTO_RELOAD_ENCODE || 'off').toLowerCase() === 'on';
  if (fpsLow || kLow) {
    encodeBelowTargetStreak++;
    issues.push(`encode_below_target:${enc.fps}fps/${enc.bitrateK}k`);
    score -= 10;
    if (autoReload && encodeBelowTargetStreak >= 2) {
      try {
        const r = await postJson('/live-grid/reload-encode');
        if (r.data?.ok) {
          actions.push(`reload-encode → ${JSON.stringify(r.data.encode || r.data)}`);
          encodeBelowTargetStreak = 0;
        }
      } catch (e) {
        issues.push(`encode_reload_failed:${e.message}`);
      }
    }
  } else {
    encodeBelowTargetStreak = 0;
  }

  const quads = await probeQuads();
  const badQuads = quads.filter((q) => !q.ok);
  if (badQuads.length) {
    issues.push(`rtsp_probe_fail:${badQuads.map((q) => q.quad).join(',')}`);
    score -= badQuads.length * 8;
  }

  const cpu = await masterCpu();
  const ffmpegSnap = await ffmpegSnapshot();
  const profile = lockedProfile();
  const viewer = buildViewerExperience({
    st,
    enc,
    quads,
    issues,
    logHits,
    masterCpu: cpu?.cpu,
    ffmpegSnap,
    profile,
    relayChurnSum: churnSum,
    maxRelayRestarts: maxRelay,
  });

  const viewerSeeing = [];
  if (viewer.viewerScore < 80) {
    if (viewer.pipeline.totalFfmpegCpu > 100) viewerSeeing.push('Stutter / lag — CPU cannot keep real-time pace');
    if (viewer.viewerIssues.includes('upscale_path')) viewerSeeing.push('Mushy or blocky tiles — upscaling low-res relay output');
    if (viewer.viewerIssues.includes('low_relay_bitrate')) viewerSeeing.push('Blocky quadrants — relay bitrate too low (1000k for 640×360 tiles)');
    if (viewer.viewerIssues.includes('sources_1080p60')) viewerSeeing.push('Source is 1080p60 Twitch — normal for baseline (copy relay → master scales to 960×540 cells)');
    if (viewer.viewerIssues.includes('relay_churn') || viewer.viewerIssues.includes('relay_restarts_session')) {
      viewerSeeing.push('Audio cuts / frozen tiles — relay UDP gaps');
    }
    if (viewer.viewerIssues.includes('master_restarts')) viewerSeeing.push('Periodic full glitches — encoder restarted this session');
    if (viewer.viewerIssues.includes('music_guard')) viewerSeeing.push('Audio jumping between streamers — music guard active');
  }
  if (!viewerSeeing.length) {
    viewerSeeing.push('Pipeline matches locked profile — if YouTube still looks bad, source streamers or YouTube CDN may be the limit');
  }

  if (cpu?.cpu > 130) {
    issues.push(`master_cpu_high:${cpu.cpu}%`);
    score -= 15;
  }

  if (st.audio?.fallbackMusic) {
    issues.push('fallback_music_on_air');
    score -= 5;
  }

  score = Math.max(0, score);
  const level = score < 50 || issues.some((i) => i === 'master_down' || i.startsWith('youtube_stale'))
    ? 'critical'
    : score < 70 || issues.length ? 'warn' : 'good';

  const msg = issues.length
    ? issues.join(', ')
    : warmupRemaining > 0
      ? `warming up · ${enc.fps}fps ${enc.bitrateK}k · master ${masterUp}s · ~${warmupRemaining}s to green`
      : `healthy ${enc.fps}fps ${enc.bitrateK}k · master ${masterUp}s · score ${score}`;

  logEvent({
    event: 'tick',
    level: viewer.viewerLevel === 'critical' ? 'critical' : (level === 'good' && viewer.viewerLevel === 'good' ? 'info' : 'warn'),
    score,
    viewerScore: viewer.viewerScore,
    viewerLevel: viewer.viewerLevel,
    msg: viewer.viewerSummary,
    issues,
    viewerIssues: viewer.viewerIssues,
    resolutions: viewer.resolutions,
    profile: viewer.profile,
    pipeline: viewer.pipeline,
    viewerSeeing,
    audio: st.audio,
    actions,
    encode: enc,
    youtube: st.youtube,
    relayRestarts,
    relayChurn,
    masterUptimeSec: masterUp,
    masterRestarts,
    masterCpu: cpu?.cpu,
    warmupRemaining,
    gridUptimeSec: gridUp,
    quads,
    logHitCount: logHits.length,
  });

  writeSummary({
    ts: new Date().toISOString(),
    level,
    score,
    viewerScore: viewer.viewerScore,
    viewerLevel: viewer.viewerLevel,
    viewerSummary: viewer.viewerSummary,
    msg,
    issues,
    viewerIssues: viewer.viewerIssues,
    resolutions: viewer.resolutions,
    profile: viewer.profile,
    pipeline: viewer.pipeline,
    viewerSeeing,
    audio: st.audio,
    actions,
    encode: enc,
    youtube: st.youtube,
    relayRestarts,
    relayChurn,
    masterUptimeSec: masterUp,
    masterRestarts,
    masterCpu: cpu?.cpu,
    warmupRemaining,
    quads,
    logHits,
  });

  saveState({
    sidecarLogOffset,
    prevRelayRestarts,
    prevGridUptime,
  });
}

async function main() {
  const st = loadState();
  if (fs.existsSync(SIDECAR_LOG)) {
    const size = fs.statSync(SIDECAR_LOG).size;
    sidecarLogOffset = st.sidecarLogOffset != null ? st.sidecarLogOffset : size;
  } else {
    sidecarLogOffset = 0;
  }
  if (Array.isArray(st.prevRelayRestarts) && st.prevRelayRestarts.length === 4) {
    prevRelayRestarts = [...st.prevRelayRestarts];
  }
  if (st.prevGridUptime) prevGridUptime = st.prevGridUptime;
  await syncRelayBaselineFromSidecar();
  logEvent({ event: 'start', msg: `watching ${SIDECAR} every ${INTERVAL_MS}ms → ${SUMMARY_PATH}` });
  for (;;) {
    try { await tick(); } catch (e) {
      logEvent({ event: 'tick_error', level: 'warn', msg: e.message });
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error('[stream-health] fatal', e);
  process.exit(1);
});
