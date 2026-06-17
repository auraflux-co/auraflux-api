'use strict';
/**
 * Read-only RTSP A/V sampling for Live Grid monitoring.
 * Short ffmpeg grabs — does not restart relays, master, or sidecar.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { ffmpegPath } = require('../ffmpeg_utils');

const execFileAsync = promisify(execFile);

/** Local ffmpeg for RTSP grabs — avoids Docker wrapper latency on localhost probes. */
function probeFfmpegBin() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (process.env.STREAM_AV_PROBE_USE_LOCAL_FFMPEG === 'false') return ffmpegPath();
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

const RTSP_BASE = process.env.LIVE_GRID_RTSP_BASE || 'rtsp://localhost:8554';
const PROBE_TIMEOUT_MS = parseInt(process.env.STREAM_AV_PROBE_TIMEOUT_MS || '18000', 10);
const AUDIO_SEC = parseFloat(process.env.STREAM_AV_PROBE_AUDIO_SEC || '6');
const BLACK_YAVG = parseFloat(process.env.STREAM_AV_PROBE_BLACK_YAVG || '12');
/** Mean must be at or below this AND peak quiet to call silent (avoids quiet speech gaps). */
const SILENT_MEAN_DB = parseFloat(process.env.STREAM_AV_PROBE_SILENT_MEAN_DB || '-50');
const SILENT_MAX_DB = parseFloat(process.env.STREAM_AV_PROBE_SILENT_MAX_DB || '-32');
/** Sustained loudness — peak alone on relay transcodes often hits 0 dB without true clip. */
const CLIP_MAX_DB = parseFloat(process.env.STREAM_AV_PROBE_CLIP_MAX_DB || '-0.5');
const CLIP_MEAN_DB = parseFloat(process.env.STREAM_AV_PROBE_CLIP_MEAN_DB || '-10');
/** Brief dropouts below this level for this long count as gaps (choppy audio). */
const SILENCE_DETECT_DB = parseFloat(process.env.STREAM_AV_PROBE_SILENCE_DETECT_DB || '-38');
const SILENCE_DETECT_MIN_SEC = parseFloat(process.env.STREAM_AV_PROBE_SILENCE_MIN_SEC || '0.06');
const CHOPPY_GAP_WARN = parseInt(process.env.STREAM_AV_PROBE_CHOPPY_GAPS_WARN || '2', 10);
const CHOPPY_GAP_CRITICAL = parseInt(process.env.STREAM_AV_PROBE_CHOPPY_GAPS_CRITICAL || '4', 10);
const CHOPPY_SILENCE_RATIO_WARN = parseFloat(process.env.STREAM_AV_PROBE_CHOPPY_RATIO_WARN || '0.12');
const CHOPPY_SILENCE_RATIO_CRITICAL = parseFloat(process.env.STREAM_AV_PROBE_CHOPPY_RATIO_CRITICAL || '0.28');
const CHOPPY_LONG_GAP_SEC = parseFloat(process.env.STREAM_AV_PROBE_LONG_GAP_SEC || '0.35');

function rtspUrl(quad) {
  return `${RTSP_BASE.replace(/\/$/, '')}/quad${quad}`;
}

function parseSignalstats(stderr) {
  const yavg = stderr.match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
  const ydin = stderr.match(/lavfi\.signalstats\.YDIF=([0-9.]+)/);
  return {
    yavg: yavg ? parseFloat(yavg[1]) : null,
    ydif: ydin ? parseFloat(ydin[1]) : null,
  };
}

function parseVolumedetect(stderr) {
  const mean = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/i);
  const max = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/i);
  return {
    meanDb: mean ? parseFloat(mean[1]) : null,
    maxDb: max ? parseFloat(max[1]) : null,
  };
}

/** Count brief silence gaps — choppy audio has many; volumedetect alone misses this. */
function parseSilenceEvents(stderr) {
  const gaps = [];
  let totalSilenceSec = 0;
  for (const m of stderr.matchAll(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/g)) {
    const duration = parseFloat(m[2]);
    if (!Number.isFinite(duration)) continue;
    gaps.push({ endSec: parseFloat(m[1]), durationSec: duration });
    totalSilenceSec += duration;
  }
  return { gapCount: gaps.length, totalSilenceSec, gaps };
}

const LEVEL_RANK = { good: 0, warn: 1, critical: 2 };

function mergeAudioClassify(a, b) {
  const level = LEVEL_RANK[a.level] >= LEVEL_RANK[b.level] ? a.level : b.level;
  const issues = [...new Set([...(a.issues || []), ...(b.issues || [])])];
  const summary = issues.length ? issues.join(', ') : (a.summary || b.summary);
  return { level, issues, summary };
}

function classifyAudioContinuity(silence, sampleSec) {
  const issues = [];
  let level = 'good';
  if (!silence || sampleSec <= 0) {
    return { level, issues, gapCount: 0, silenceRatio: 0, totalSilenceSec: 0 };
  }
  const ratio = silence.totalSilenceSec / sampleSec;
  const longGaps = (silence.gaps || []).filter((g) => g.durationSec >= CHOPPY_LONG_GAP_SEC);
  const candidates = [];

  if (longGaps.length >= 1) {
    issues.push('audio_dropout');
    candidates.push(longGaps.some((g) => g.durationSec >= 0.75) ? 'critical' : 'warn');
  }
  if (silence.gapCount >= CHOPPY_GAP_CRITICAL || ratio >= CHOPPY_SILENCE_RATIO_CRITICAL) {
    issues.push('audio_choppy_gaps');
    candidates.push('critical');
  } else if (silence.gapCount >= CHOPPY_GAP_WARN || ratio >= CHOPPY_SILENCE_RATIO_WARN) {
    issues.push('audio_gaps_detected');
    candidates.push('warn');
  }

  for (const c of candidates) {
    if (LEVEL_RANK[c] > LEVEL_RANK[level]) level = c;
  }
  const summary = issues.length
    ? `${issues[0]} (${silence.gapCount} gaps, ${(ratio * 100).toFixed(0)}% silent in ${sampleSec}s)`
    : `continuous (${silence.gapCount} micro-gaps)`;
  return {
    level,
    issues,
    summary,
    gapCount: silence.gapCount,
    silenceRatio: Math.round(ratio * 1000) / 1000,
    totalSilenceSec: Math.round(silence.totalSilenceSec * 1000) / 1000,
  };
}

function classifyVideo(stats, { frozenStreak = 0 } = {}) {
  const issues = [];
  let level = 'good';
  if (stats.frameError) {
    return { level: 'critical', issues: ['frame_capture_failed'], summary: 'Could not grab video frame' };
  }
  if (stats.yavg != null && stats.yavg < BLACK_YAVG) {
    issues.push('black_or_blank_frame');
    level = 'critical';
  }
  if (stats.ydif != null && stats.ydif < 1.5) {
    issues.push('low_motion_static');
    if (level === 'good') level = 'warn';
  }
  if (frozenStreak >= 2) {
    issues.push('frozen_frame_suspected');
    level = 'critical';
  }
  const summary = issues.length
    ? issues.join(', ')
    : `frame ok (YAVG=${stats.yavg?.toFixed?.(1) ?? '?'}, motion=${stats.ydif?.toFixed?.(1) ?? '?'})`;
  return { level, issues, summary };
}

function classifyAudio(vol) {
  const issues = [];
  let level = 'good';
  if (vol.error) {
    return { level: 'critical', issues: ['audio_sample_failed'], summary: vol.error };
  }
  if (vol.meanDb == null) {
    return { level: 'warn', issues: ['volume_parse_failed'], summary: 'Could not parse audio levels' };
  }

  const maxDb = vol.maxDb;
  const meanDb = vol.meanDb;
  const peakQuiet = maxDb == null || maxDb <= SILENT_MAX_DB;
  const peakHot = maxDb != null && maxDb >= CLIP_MAX_DB;
  const meanSilent = meanDb <= SILENT_MEAN_DB;
  const meanVeryQuiet = meanDb <= SILENT_MEAN_DB + 10;
  const meanSustainedHot = meanDb >= CLIP_MEAN_DB;

  // Silent = quiet average AND no loud peaks in the sample window
  if (meanSilent && peakQuiet) {
    issues.push('silent_or_near_silent');
    level = 'critical';
  } else if (meanVeryQuiet && peakQuiet) {
    issues.push('very_quiet');
    level = 'warn';
  }

  // Clipping = sustained loud content, not relay peak-at-0 alone (common on Twitch relays)
  if (peakHot && meanSustainedHot) {
    issues.push('clipping_suspected');
    level = level === 'critical' ? 'critical' : 'warn';
  } else if (peakHot && !meanSustainedHot) {
    // Occasional peak-at-0 on relay transcodes — not actionable
    if (level === 'good') level = 'good';
  }

  const summary = issues.length
    ? issues.join(', ')
    : `active audio (mean ${meanDb.toFixed(1)} dB, peak ${maxDb?.toFixed?.(1) ?? '?'} dB)`;
  return { level, issues, summary };
}

async function runFfmpeg(args) {
  const bin = probeFfmpegBin();
  try {
    const { stderr } = await execFileAsync(bin, args, {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stderr: stderr || '' };
  } catch (e) {
    return { ok: false, stderr: e.stderr || e.message || String(e) };
  }
}

/** Grab one frame + signalstats from RTSP (read-only). */
async function probeVideoFrame(quad, { snapshotPath = null } = {}) {
  const url = rtspUrl(quad);
  const args = [
    '-hide_banner', '-loglevel', 'info',
    '-rtsp_transport', 'tcp',
    '-i', url,
    '-frames:v', '1',
    '-an',
    '-vf', 'scale=320:-2,signalstats=stat=tout+vrep',
    '-f', 'null', '-',
  ];
  const run = await runFfmpeg(args);
  const stats = parseSignalstats(run.stderr);
  let frameHash = null;
  let snapshotSaved = null;

  if (snapshotPath) {
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    const snapArgs = [
      '-hide_banner', '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-i', url,
      '-frames:v', '1',
      '-q:v', '4',
      '-y', snapshotPath,
    ];
    const snap = await runFfmpeg(snapArgs);
    if (snap.ok && fs.existsSync(snapshotPath) && fs.statSync(snapshotPath).size > 500) {
      const buf = fs.readFileSync(snapshotPath);
      frameHash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 12);
      snapshotSaved = snapshotPath;
    }
  }

  return {
    quad,
    url,
    ok: run.ok,
    frameError: run.ok ? null : run.stderr.slice(0, 200),
    yavg: stats.yavg,
    ydif: stats.ydif,
    frameHash,
    snapshotPath: snapshotSaved,
  };
}

/** Sample ~6s audio and run volumedetect (read-only). */
async function probeAudioLevels(quad) {
  const url = rtspUrl(quad);
  const args = [
    '-hide_banner', '-loglevel', 'info',
    '-rtsp_transport', 'tcp',
    '-i', url,
    '-t', String(AUDIO_SEC),
    '-vn', '-sn',
    '-ac', '1',
    '-ar', '16000',
    '-af', `silencedetect=noise=${SILENCE_DETECT_DB}dB:d=${SILENCE_DETECT_MIN_SEC},volumedetect`,
    '-f', 'null', '-',
  ];
  const run = await runFfmpeg(args);
  const vol = parseVolumedetect(run.stderr);
  const silence = parseSilenceEvents(run.stderr);
  const volumeClass = classifyAudio({ ...vol, error: run.ok ? null : run.stderr.slice(0, 200) });
  const continuityClass = classifyAudioContinuity(silence, AUDIO_SEC);
  const merged = mergeAudioClassify(volumeClass, continuityClass);
  return {
    quad,
    url,
    ok: run.ok,
    error: run.ok ? null : run.stderr.slice(0, 200),
    meanDb: vol.meanDb,
    maxDb: vol.maxDb,
    gapCount: silence.gapCount,
    silenceRatio: continuityClass.silenceRatio,
    totalSilenceSec: continuityClass.totalSilenceSec,
    sampleSec: AUDIO_SEC,
    level: merged.level,
    issues: merged.issues,
    summary: merged.summary,
  };
}

/**
 * Full read-only A/V probe for one quadrant.
 * @param {object} opts
 * @param {number} opts.quad 1-4
 * @param {string} [opts.login]
 * @param {string} [opts.snapshotDir] if set, writes q{N}_latest.jpg
 * @param {object} [opts.prevHashes] { frameHash, frozenStreak }
 */
async function probeQuadrantAv({ quad, login = null, snapshotDir = null, prevHashes = {} }) {
  const snapshotPath = snapshotDir
    ? path.join(snapshotDir, `q${quad}_latest.jpg`)
    : null;

  const [video, audio] = await Promise.all([
    probeVideoFrame(quad, { snapshotPath }),
    probeAudioLevels(quad),
  ]);

  let frozenStreak = prevHashes.frozenStreak || 0;
  if (video.frameHash && prevHashes.frameHash === video.frameHash) {
    frozenStreak += 1;
  } else {
    frozenStreak = 0;
  }

  const videoClass = classifyVideo(video, { frozenStreak });
  const audioClass = {
    level: audio.level,
    issues: audio.issues,
    summary: audio.summary,
  };

  return {
    quad,
    login,
    video: { ...video, ...videoClass, frozenStreak },
    audio: { ...audio, ...audioClass },
    state: { frameHash: video.frameHash || prevHashes.frameHash || null, frozenStreak },
  };
}

function overallAvLevel(probes) {
  const levels = probes.flatMap((p) => [p.video.level, p.audio.level]);
  if (levels.includes('critical')) return 'critical';
  if (levels.includes('warn')) return 'warn';
  return 'good';
}

module.exports = {
  rtspUrl,
  parseSignalstats,
  parseVolumedetect,
  parseSilenceEvents,
  classifyVideo,
  classifyAudio,
  classifyAudioContinuity,
  mergeAudioClassify,
  probeVideoFrame,
  probeAudioLevels,
  probeQuadrantAv,
  overallAvLevel,
};
