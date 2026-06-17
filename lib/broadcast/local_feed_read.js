'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  resolveLocalPreviewConfig,
  hlsPreviewReady,
  twitchWatchUrl,
  rtspQuadUrl,
} = require('../live_grid/local_preview');
const { readAvProbeReport } = require('./av_probe_read');
const { readLiveMonitorReport } = require('./live_monitor_read');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'logs', 'stream_probe_snapshots');

function fetchSidecarJson(urlPath) {
  const sidecar = (process.env.LIVE_SIDECAR_URL || `http://127.0.0.1:${process.env.LIVE_SIDECAR_PORT || 3001}`).replace(/\/$/, '');
  return new Promise((resolve) => {
    const req = http.get(`${sidecar}${urlPath}`, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function readLocalFeedReport() {
  const preview = resolveLocalPreviewConfig();
  const gridStatus = await fetchSidecarJson('/live-grid/status');
  const avProbe = readAvProbeReport();
  const liveMonitor = readLiveMonitorReport();

  const onAirQuad = gridStatus?.audio?.quadrant ?? liveMonitor.grid?.onAirQuad ?? null;
  const quadrants = (gridStatus?.quadrants || liveMonitor.grid?.quadrants || []).map((q) => {
    const quad = q.quadrant ?? q.quad;
    const login = q.login || q.displayName || null;
    return {
      quadrant: quad,
      login,
      twitchWatchUrl: twitchWatchUrl(login),
      rtspUrl: rtspQuadUrl(preview.rtspBase, quad),
      snapshotPath: fs.existsSync(path.join(SNAPSHOT_DIR, `q${quad}_latest.jpg`))
        ? `logs/stream_probe_snapshots/q${quad}_latest.jpg`
        : null,
    };
  });

  const hlsReady = hlsPreviewReady();
  const gridRunning = !!gridStatus?.running;

  return {
    ok: true,
    mode: preview.localOnly ? 'local_only' : (gridRunning ? 'localhost_qa' : 'offline'),
    gridRunning,
    localOnly: preview.localOnly,
    /** Composed grid — what we ship (not YouTube CDN) */
    composed: {
      hlsUrl: preview.hlsUrl,
      hlsReady,
      watchPageUrl: preview.watchPageUrl,
      note: hlsReady
        ? 'Play composed grid locally — same encode as RTMP when LIVE_GRID_LOCAL_HLS=on'
        : 'HLS not ready — restart grid after enabling LIVE_GRID_LOCAL_HLS or use LIVE_GRID_LOCAL_ONLY=on',
    },
    /** Per-quad relay taps (Twitch → MediaMTX) */
    sources: quadrants,
    onAir: {
      quadrant: onAirQuad,
      login: gridStatus?.audio?.login ?? liveMonitor.grid?.onAirLogin ?? null,
      mode: gridStatus?.audio?.mode ?? liveMonitor.grid?.audioMode ?? null,
      rtspUrl: onAirQuad ? rtspQuadUrl(preview.rtspBase, onAirQuad) : null,
      twitchWatchUrl: twitchWatchUrl(gridStatus?.audio?.login ?? liveMonitor.grid?.onAirLogin),
      snapshotPath: onAirQuad
        ? (avProbe.snapshots?.find((s) => s.name === `q${onAirQuad}_latest.jpg`)?.path || null)
        : null,
    },
    probe: {
      videoLevel: avProbe.videoLevel,
      audioLevel: avProbe.audioLevel,
      videoScore: avProbe.videoScore,
      audioScore: avProbe.audioScore,
      updatedAt: avProbe.updatedAt,
    },
    monitor: {
      level: liveMonitor.level,
      isStable: liveMonitor.isStable,
      stableStreak: liveMonitor.stableStreak,
      updatedAt: liveMonitor.updatedAt,
    },
    youtube: gridStatus?.broadcast?.watchUrl
      ? { watchUrl: gridStatus.broadcast.watchUrl, note: 'Optional — subagents should prefer composed.hlsUrl for QA' }
      : null,
    agentInstructions: {
      video: 'Open watchPageUrl or poll GET /broadcast/live-monitor — ignore YouTube unless validating publish',
      audio: 'Sample on-air rtspUrl via av-probe; compare twitchWatchUrl only for source-side issues',
      browser: `${preview.watchPageUrl} plays local HLS when hlsReady`,
    },
  };
}

module.exports = { readLocalFeedReport, fetchSidecarJson };
