'use strict';
/**
 * Viewer-facing stream health metrics + resolution paths (not uptime-only scoring).
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const RESOLUTION_PLAYBOOK = {
  total_ffmpeg_cpu: 'Total ffmpeg CPU is high — assembly/jobs compete with the grid. Pause production jobs; do not restart sidecar while live.',
  master_cpu_high: 'Master encoder overloaded — stop grid, apply locked 720p profile, start grid once (one blip).',
  master_restarts: 'Encoder restarted this session — viewers saw blips. Never reload-encode or restart sidecar during marathon.',
  relay_churn: 'Relays restarting live — UDP gaps cause video/audio glitches. Wait 2 min; if churn continues, stop grid → start with locked profile.',
  relay_restarts_session: 'Relay restarts accumulated — usually from sidecar restarts tonight. Stable only after 10+ min with zero churn.',
  upscale_path: 'Relay output is smaller than grid cells — master upscales (mushy). Match RELAY_SCALE to cell size when grid is OFF.',
  heavy_sources: '4× 1080p60 with relay transcode is heavy — use copy relays (baseline) or lower Twitch quality when grid is OFF.',
  expected_1080p60_copy: 'Normal for baseline: Twitch 1080p60 → copy relay → master scales each quad to 960×540 for the 1080p grid. High master CPU (~80–130%) is expected on this Mac.',
  low_relay_bitrate: 'Relay bitrate may be too low for tile size — blocky quadrants on YouTube. Raise LIVE_GRID_RELAY_BITRATE_K when grid is off.',
  dts_errors: 'Audio/video timestamp errors in relays — usually fixed by AAC re-encode on relays (profile default).',
  ffmpeg_decode_lag: 'ffmpeg decode lag in logs — CPU cannot keep up. Reduce output resolution or pause other work.',
  music_guard: 'Music guard is hopping/muting audio — set LIVE_GRID_MUSIC_GUARD=off until stable, then re-enable when grid is off.',
  fallback_music: 'Copyright-safe music bed is on-air — Twitch audio replaced. Expected when all quads flagged; otherwise check music guard.',
  encode_below_target: 'Encode settings below profile target — check .env matches locked profile; reload only when grid is off.',
  youtube_stale_local: 'YouTube thinks stream is stale — RTMP may be broken. Check sidecar logs; may need stop → start grid.',
  youtube_not_live: 'Not live on YouTube — confirm RTMP key and broadcast listing.',
  master_down: 'Master encoder is down — grid cannot output. Auto-resume or manual start from Broadcast tab.',
  rtsp_probe_fail: 'Quadrant RTSP dead — that tile blank/glitched. Feeder or relay will self-heal; persistent fail = swap quadrant.',
  grid_session_reset: 'Grid session reset (sidecar restart) — expect 30–90s of bad quality while relays warm up.',
  sidecar_restarts_tonight: 'Multiple sidecar restarts this session — each one causes a viewer blip. Lock profile; troubleshoot only when OFF.',
};

function parseFps(r) {
  if (!r) return 0;
  const [a, b] = String(r).split('/').map(Number);
  if (!a || !b) return 0;
  return a / b;
}

function lockedProfile(env = process.env) {
  const outW = parseInt(env.LIVE_GRID_OUTPUT_W || '1920', 10);
  const outH = parseInt(env.LIVE_GRID_OUTPUT_H || '1080', 10);
  const cellW = Math.floor(outW / 2);
  const cellH = Math.floor(outH / 2);
  const relayOn = String(env.LIVE_GRID_RELAY_TRANSCODE || 'off').toLowerCase() === 'on';
  return {
    name: env.LIVE_GRID_PROFILE_NAME || 'c0-baseline-1080p',
    output: `${outW}×${outH}`,
    cell: `${cellW}×${cellH}`,
    fps: parseInt(env.LIVE_GRID_FPS || '24', 10),
    bitrateK: parseInt(env.LIVE_GRID_BITRATE_K || '3500', 10),
    audioK: parseInt(env.LIVE_GRID_AUDIO_BITRATE_K || '192', 10),
    twitchQuality: env.LIVE_GRID_TWITCH_QUALITY || '720p',
    relayTranscode: relayOn,
    relayScale: relayOn
      ? `${env.LIVE_GRID_RELAY_SCALE_W || cellW}×${env.LIVE_GRID_RELAY_SCALE_H || cellH}`
      : 'copy',
    relayBitrateK: parseInt(env.LIVE_GRID_RELAY_BITRATE_K || '0', 10) || null,
    relayFps: parseInt(env.LIVE_GRID_RELAY_FPS || env.LIVE_GRID_FPS || '24', 10),
    musicGuard: String(env.LIVE_GRID_MUSIC_GUARD || 'on').toLowerCase() !== 'off',
    musicUseBed: String(env.LIVE_GRID_MUSIC_USE_BED || 'off').toLowerCase() === 'on',
    healthAutoReload: String(env.STREAM_HEALTH_AUTO_RELOAD_ENCODE || 'off').toLowerCase() === 'on',
  };
}

async function ffmpegSnapshot() {
  const out = { master: null, relays: [], totalCpu: 0 };
  try {
    const { stdout } = await execFileAsync('ps', ['aux'], { timeout: 5000 });
    for (const line of String(stdout).split('\n')) {
      if (!line.includes('ffmpeg')) continue;
      const parts = line.trim().split(/\s+/);
      const cpu = parseFloat(parts[2]) || 0;
      const cmd = line.slice(line.indexOf('ffmpeg'));
      if (/live2|xstack/.test(cmd)) {
        const padOnly = /\[0:v\]pad=/.test(cmd);
        out.master = {
          cpu,
          outputW: (cmd.match(/drawbox=x=0:y=0:w=(\d+)/) || [])[1] || null,
          outputH: (cmd.match(/w=\d+:h=(\d+)/) || [])[1] || null,
          cellW: (cmd.match(/\[0:v\]pad=(\d+):(\d+)/) || cmd.match(/\[0:v\]scale=(\d+):(\d+)/) || [])[1] || null,
          cellH: (cmd.match(/\[0:v\]pad=(\d+):(\d+)/) || cmd.match(/\[0:v\]scale=(\d+):(\d+)/) || [])[2] || null,
          padOnly,
          upscale: /\[0:v\]scale=/.test(cmd),
          bitrateK: (cmd.match(/-b:v (\d+)k/) || [])[1] || null,
        };
      } else if (/udp:\/\/127\.0\.0\.1:50/.test(cmd)) {
        const quad = (cmd.match(/quad(\d)/) || cmd.match(/501(\d)/) || [])[1];
        out.relays.push({
          quad: quad ? parseInt(quad, 10) : out.relays.length + 1,
          cpu,
          transcode: cmd.includes('scale=') || cmd.includes('videotoolbox'),
          copy: cmd.includes('-c copy'),
        });
      }
      if (cpu > 0.5) out.totalCpu += cpu;
    }
  } catch (_) { /* non-fatal */ }
  out.totalCpu = Math.round(out.totalCpu * 10) / 10;
  return out;
}

function buildViewerExperience(ctx) {
  const {
    st = {},
    enc = {},
    quads = [],
    issues: uptimeIssues = [],
    logHits = [],
    masterCpu = null,
    ffmpegSnap = {},
    profile = lockedProfile(),
    relayChurnSum = 0,
    maxRelayRestarts = 0,
    sidecarRestarts = null,
  } = ctx;

  const viewerIssues = [];
  const resolutions = [];
  let viewerScore = 100;

  const snap = ffmpegSnap.master || {};
  const cellW = parseInt(profile.cell.split('×')[0], 10);
  const cellH = parseInt(profile.cell.split('×')[1], 10);
  const relayW = parseInt((profile.relayScale || '').split('×')[0], 10) || 0;

  // Upscale mush only when relay transcodes smaller than compositor cells — NOT master scale-down on copy path.
  if (profile.relayTranscode && relayW && relayW < cellW) {
    viewerIssues.push('upscale_path');
    viewerScore -= 25;
    resolutions.push({ key: 'upscale_path', text: RESOLUTION_PLAYBOOK.upscale_path });
  }

  const heavy = quads.filter((q) => q.ok && q.w >= 1280 && parseFps(q.fps) >= 50).length;
  if (heavy >= 3 && profile.relayTranscode) {
    viewerIssues.push('heavy_sources');
    viewerScore -= 12;
    resolutions.push({ key: 'heavy_sources', text: RESOLUTION_PLAYBOOK.heavy_sources });
  } else if (heavy >= 3 && !profile.relayTranscode) {
    // Expected baseline — informational only, no score penalty
    viewerIssues.push('sources_1080p60');
  }

  if (profile.relayBitrateK && profile.relayBitrateK < 1400 && profile.relayTranscode) {
    viewerIssues.push('low_relay_bitrate');
    viewerScore -= 10;
    resolutions.push({ key: 'low_relay_bitrate', text: RESOLUTION_PLAYBOOK.low_relay_bitrate });
  }

  const totalCpu = ffmpegSnap.totalCpu || masterCpu || 0;
  const cpuWarnTotal = profile.relayTranscode ? 100 : 150;
  if (totalCpu > cpuWarnTotal) {
    viewerIssues.push('total_ffmpeg_cpu');
    viewerScore -= Math.min(25, Math.round((totalCpu - cpuWarnTotal) / 5));
    resolutions.push({ key: 'total_ffmpeg_cpu', text: RESOLUTION_PLAYBOOK.total_ffmpeg_cpu });
  }

  const cpuWarnMaster = profile.relayTranscode ? 70 : 130;
  if (masterCpu > cpuWarnMaster) {
    viewerIssues.push('master_cpu_high');
    viewerScore -= 15;
    resolutions.push({ key: 'master_cpu_high', text: RESOLUTION_PLAYBOOK.master_cpu_high });
  }

  const masterRestarts = st.master?.restarts || 0;
  if (masterRestarts > 0) {
    viewerIssues.push('master_restarts');
    viewerScore -= Math.min(20, masterRestarts * 10);
    resolutions.push({ key: 'master_restarts', text: RESOLUTION_PLAYBOOK.master_restarts });
  }

  if (relayChurnSum >= 2) {
    viewerIssues.push('relay_churn');
    viewerScore -= 15;
    resolutions.push({ key: 'relay_churn', text: RESOLUTION_PLAYBOOK.relay_churn });
  }

  if (maxRelayRestarts >= 3) {
    viewerIssues.push('relay_restarts_session');
    viewerScore -= 10;
    resolutions.push({ key: 'relay_restarts_session', text: RESOLUTION_PLAYBOOK.relay_restarts_session });
  }

  if (sidecarRestarts != null && sidecarRestarts >= 5) {
    viewerIssues.push('sidecar_restarts_tonight');
    viewerScore -= 15;
    resolutions.push({ key: 'sidecar_restarts_tonight', text: RESOLUTION_PLAYBOOK.sidecar_restarts_tonight });
  }

  if (profile.musicGuard && (st.audio?.musicWarning || logHits.some((h) => /music guard/i.test(h.line)))) {
    viewerIssues.push('music_guard');
    viewerScore -= 10;
    resolutions.push({ key: 'music_guard', text: RESOLUTION_PLAYBOOK.music_guard });
  }

  if (st.audio?.fallbackMusic) {
    viewerIssues.push('fallback_music');
    viewerScore -= 5;
    resolutions.push({ key: 'fallback_music', text: RESOLUTION_PLAYBOOK.fallback_music });
  }

  for (const issue of uptimeIssues) {
    const key = issue.split(':')[0];
    if (RESOLUTION_PLAYBOOK[key] && !resolutions.some((r) => r.key === key)) {
      resolutions.push({ key, text: RESOLUTION_PLAYBOOK[key] });
    }
    if (key === 'dts_errors') viewerScore -= 10;
    if (key.startsWith('ffmpeg_decode_lag')) viewerScore -= 20;
  }

  viewerScore = Math.max(0, Math.min(100, viewerScore));
  const viewerLevel = viewerScore < 50 ? 'critical' : viewerScore < 75 ? 'warn' : 'good';

  const pipeline = {
    detectedOutput: snap.outputW && snap.outputH ? `${snap.outputW}×${snap.outputH}` : profile.output,
    detectedCell: snap.cellW && snap.cellH ? `${snap.cellW}×${snap.cellH}` : profile.cell,
    padOnly: snap.padOnly,
    masterCpu: masterCpu ?? snap.cpu,
    totalFfmpegCpu: totalCpu,
    relayCount: ffmpegSnap.relays?.length || 0,
    relayTranscodeCount: (ffmpegSnap.relays || []).filter((r) => r.transcode).length,
  };

  const viewerSummary = viewerIssues.length
    ? (viewerIssues.includes('sources_1080p60') && viewerIssues.every((i) => i === 'sources_1080p60' || i === 'master_cpu_high'))
      ? 'Baseline 1080p60 sources on copy relays — expected path'
      : `Viewer experience degraded: ${viewerIssues.filter((i) => i !== 'sources_1080p60').join(', ') || viewerIssues.join(', ')}`
    : `Pipeline matches locked profile · ${profile.output} @ ${profile.fps}fps`;

  return {
    viewerScore,
    viewerLevel,
    viewerIssues: [...new Set(viewerIssues)],
    resolutions,
    profile,
    pipeline,
    ffmpegSnap,
    viewerSummary,
  };
}

module.exports = {
  lockedProfile,
  parseFps,
  ffmpegSnapshot,
  buildViewerExperience,
  RESOLUTION_PLAYBOOK,
};
