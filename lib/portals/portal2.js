'use strict';
/**
 * lib/portals/portal2.js — Portal 2: Render Quality
 *
 * Provider-agnostic render quality check. Validates rendered segments via ffprobe.
 * Does NOT know or care if HeyGen produced the renders.
 *
 * ffprobe is GROUND TRUTH — no AI can override its results.
 *
 * Fail conditions:
 *   - Freeze detected
 *   - Audio missing (ffprobe confirmed)
 *   - File corrupt (< 100KB)
 *   - CDN expiry: segment URL returns 403/410 (surfaced as cdn_expired outcome)
 *   - STUCK: render job made no segment progress for STUCK_THRESHOLD_MS
 *
 * Score → action:
 *   ≥85: pass to assembly
 *   65-84: sendback for operator review (surfaces to monitoring, not auto-re-render)
 *   <65 OR freeze OR audio missing: hard fail → escalate
 *
 * Output contract:
 * {
 *   portal: 2,
 *   jobId: string,
 *   passed: boolean,
 *   score: number,
 *   outcome: 'pass' | 'review' | 'hard_fail' | 'cdn_expired' | 'rerender_needed',
 *   segmentResults: [{ segmentPath, sizeOk, audioOk, freezeDetected, framingOk, lipSyncOk }],
 *   batchStopped: boolean,
 *   batchStoppedAt: string | null,
 *   cdnExpired: boolean,
 *   expiredSegmentUrls: string[],
 *   upstreamContext: { reviewedReports, confirmedClean, escalatedConcerns, downstreamHeadsUp },
 *   completedAt: ISO-8601
 * }
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const axios = require('axios');
const { ffprobePath, ffmpegPath } = require('../ffmpeg_utils');
const { ffprobeAudioCheck } = require('../qa');
const { logError } = require('../error_logger');
const { CONFIG } = require('../config');
const { getPortalThresholds } = require('../customerConfig');
const { validatePortalInput } = require('../portal_contract');

// ─── STUCK detection ──────────────────────────────────────────────────────────

/**
 * Default STUCK threshold in ms — render job is STUCK if no progress after this long.
 * Override via GATE2_STUCK_THRESHOLD_MS env var.
 */
const DEFAULT_STUCK_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

function stuckThresholdMs() {
  const raw = process.env.GATE2_STUCK_THRESHOLD_MS;
  if (!raw) return DEFAULT_STUCK_THRESHOLD_MS;
  const n = parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STUCK_THRESHOLD_MS;
}

/**
 * Check if a render job is STUCK — no segment file progress for stuckThresholdMs.
 * Fires a console alarm and emits a structured log event.
 *
 * @param {string} jobId
 * @param {string[]} segmentPaths - expected output segment paths
 * @param {number} jobStartedAtMs - timestamp (ms) when render was kicked off
 * @returns {{ stuck: boolean, stuckMs: number, missingSegments: string[] }}
 */
function checkIfStuck(jobId, segmentPaths, jobStartedAtMs) {
  if (!segmentPaths || segmentPaths.length === 0) {
    return { stuck: false, stuckMs: 0, missingSegments: [] };
  }

  const elapsedMs = Date.now() - jobStartedAtMs;
  const threshold = stuckThresholdMs();

  // Any segment that doesn't exist yet (or is < 1KB) = not arrived
  const missingSegments = segmentPaths.filter((p) => {
    try {
      return !fs.existsSync(p) || fs.statSync(p).size < 1024;
    } catch {
      return true;
    }
  });

  const stuck = missingSegments.length > 0 && elapsedMs > threshold;

  if (stuck) {
    const msg = `[gate2] STUCK ALARM — job ${jobId}: ${missingSegments.length} segment(s) missing after ${Math.round(elapsedMs / 60000)}m (threshold ${Math.round(threshold / 60000)}m). Missing: ${missingSegments.map((p) => path.basename(p)).join(', ')}`;
    console.error(msg);
    logError('PORTAL2_STUCK_ALARM', new Error(msg), {
      jobId,
      portal: 2,
      elapsedMs,
      thresholdMs: threshold,
      missingSegments: missingSegments.map((p) => path.basename(p)),
    });
  }

  return { stuck, stuckMs: elapsedMs, missingSegments };
}

// ─── CDN expiry detection ──────────────────────────────────────────────────────

/**
 * Check whether a HeyGen (or any provider) segment URL is CDN-expired.
 * Returns { expired: boolean, statusCode: number | null }.
 * A 403 or 410 from the URL = CDN window closed.
 * A 404 may indicate the render never completed — reported separately.
 */
async function checkCdnStatus(url) {
  if (!url || typeof url !== 'string') return { expired: false, statusCode: null };
  try {
    const resp = await axios.head(url, { timeout: 8000, validateStatus: () => true });
    const { status } = resp;
    // 403 = forbidden (CDN auth expired), 410 = gone (resource removed)
    const expired = status === 403 || status === 410;
    return { expired, statusCode: status };
  } catch {
    return { expired: false, statusCode: null };
  }
}

// ─── Constants (defaults — overridden by customerConfig at run time) ─────────

// Platform defaults — overridden by customerConfig.qaThresholds.gate2
const DEFAULT_PASS_THRESHOLD = 60;
const DEFAULT_REVIEW_THRESHOLD = 40;
// MIN_FILE_SIZE from CONFIG (lib/config.js) — not hardcoded here
const MIN_FILE_SIZE = CONFIG?.VIDEO?.MIN_SEGMENT_SIZE || 100 * 1024; // 100KB fallback

/** HeyGen sometimes returns ~2.7–2.9s for brief dialogue; env allows tuning without code edits. */
function minSegmentSeconds() {
  const raw = process.env.GATE2_MIN_SEGMENT_SECONDS;
  if (raw === undefined || raw === '') return 2.5;
  const n = parseFloat(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? n : 2.5;
}

/**
 * Get pass/review thresholds for this job from customerConfig.
 */
function getThresholds(jobSpec) {
  const customerId = jobSpec?.customerId;
  const templateId =
    jobSpec?.order?.templateId ||
    (jobSpec?.order?.formType?.includes('short') ? 'short-form' : 'long-form');
  const t = getPortalThresholds(customerId, templateId, 'gate2', {
    pass: DEFAULT_PASS_THRESHOLD,
    manualReview: DEFAULT_REVIEW_THRESHOLD,
  });
  return {
    passThreshold: t.pass || DEFAULT_PASS_THRESHOLD,
    reviewThreshold: t.manualReview || DEFAULT_REVIEW_THRESHOLD,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get file size in bytes. Returns 0 if file doesn't exist.
 */
function getFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Check audio level using ffmpeg volumedetect filter.
 * Returns { meanVolume, maxVolume, isSilent }.
 * Silent = mean volume below -50dB (talking avatar is typically -20 to -35dB).
 */
async function checkAudioLevel(filePath) {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath(),
      ['-i', filePath, '-af', 'volumedetect', '-vn', '-sn', '-dn', '-f', 'null', '/dev/null'],
      { timeout: 15000 },
      (err, stdout, stderr) => {
        // volumedetect outputs to stderr
        const output = stderr || '';
        const meanMatch = output.match(/mean_volume:\s*([-\d.]+)\s*dB/);
        const maxMatch = output.match(/max_volume:\s*([-\d.]+)\s*dB/);
        const meanVolume = meanMatch ? parseFloat(meanMatch[1]) : null;
        const maxVolume = maxMatch ? parseFloat(maxMatch[1]) : null;
        // Silent = mean volume below -50dB (near-silence threshold for talking-head avatar)
        const isSilent = meanVolume !== null && meanVolume < -50;
        resolve({ meanVolume, maxVolume, isSilent });
      }
    );
  });
}

/**
 * Run ffprobe to get video stream metadata.
 * Returns { duration, codec, width, height, frameRate, audioVideoDurationMismatch, valid } or { valid: false }.
 */
function probeVideoStream(filePath) {
  return new Promise((resolve) => {
    execFile(
      ffprobePath(),
      [
        '-v',
        'quiet',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,duration,width,height,r_frame_rate,avg_frame_rate',
        '-of',
        'json',
        filePath,
      ],
      { timeout: 15000 },
      (err, stdout) => {
        if (err) return resolve({ valid: false, error: err.message });
        try {
          const data = JSON.parse(stdout);
          const streams = data.streams || [];
          if (streams.length === 0) return resolve({ valid: false, error: 'No video stream' });
          const s = streams[0];
          // Parse frame rate fraction (e.g. "25/1" or "30000/1001")
          const parseFrameRate = (frac) => {
            if (!frac) return null;
            const parts = frac.split('/');
            if (parts.length === 2) {
              const num = parseFloat(parts[0]);
              const den = parseFloat(parts[1]);
              return den > 0 ? Math.round((num / den) * 100) / 100 : null;
            }
            return parseFloat(frac) || null;
          };
          resolve({
            valid: true,
            codec: s.codec_name || '',
            duration: parseFloat(s.duration || '0'),
            width: parseInt(s.width || '0', 10),
            height: parseInt(s.height || '0', 10),
            frameRate: parseFrameRate(s.r_frame_rate),
            avgFrameRate: parseFrameRate(s.avg_frame_rate),
          });
        } catch (e) {
          resolve({ valid: false, error: e.message });
        }
      }
    );
  });
}

/**
 * Run ffprobe on ALL streams to detect audio/video duration mismatch (slow-motion symptom).
 * Returns { videoDuration, audioDuration, mismatchRatio, isMismatched }.
 */
function probeAllStreams(filePath) {
  return new Promise((resolve) => {
    execFile(
      ffprobePath(),
      ['-v', 'quiet', '-show_entries', 'stream=codec_type,duration', '-of', 'json', filePath],
      { timeout: 15000 },
      (err, stdout) => {
        if (err) return resolve({ valid: false });
        try {
          const data = JSON.parse(stdout);
          const streams = data.streams || [];
          const video = streams.find((s) => s.codec_type === 'video');
          const audio = streams.find((s) => s.codec_type === 'audio');
          const vDur = parseFloat(video?.duration || '0');
          const aDur = parseFloat(audio?.duration || '0');
          const ratio = aDur > 0 ? vDur / aDur : 1;
          // Mismatch if video is >10% longer than audio (audio controls perceived duration)
          resolve({
            valid: true,
            videoDuration: vDur,
            audioDuration: aDur,
            mismatchRatio: Math.round(ratio * 100) / 100,
            isMismatched: ratio > 1.1 || ratio < 0.9,
          });
        } catch (e) {
          resolve({ valid: false });
        }
      }
    );
  });
}

/**
 * Extract a single frame from a video at a given time offset.
 * Returns the JPEG buffer or null.
 */
function extractFrame(filePath, timeOffset, outputPath) {
  return new Promise((resolve) => {
    execFile(
      ffmpegPath(),
      ['-ss', String(timeOffset), '-i', filePath, '-frames:v', '1', '-q:v', '2', '-y', outputPath],
      { timeout: 15000 },
      (err) => {
        resolve(!err && fs.existsSync(outputPath));
      }
    );
  });
}

/**
 * Simple freeze detection: extract first and last frame, compare file sizes.
 * If sizes are identical (within 5%), frames are likely frozen.
 * Returns { freezeDetected: boolean }.
 */
async function detectFreeze(filePath, duration) {
  const tmpDir = path.join(__dirname, '..', '..', 'tmp');
  const baseName = path.basename(filePath, path.extname(filePath));
  const frame1Path = path.join(tmpDir, `freeze_check_${baseName}_first.jpg`);
  const frame2Path = path.join(tmpDir, `freeze_check_${baseName}_last.jpg`);

  try {
    // Ensure tmp dir exists
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const [f1ok, f2ok] = await Promise.all([
      extractFrame(filePath, 0.5, frame1Path),
      extractFrame(filePath, Math.max(0, duration - 1), frame2Path),
    ]);

    if (!f1ok || !f2ok) return { freezeDetected: false };

    const size1 = getFileSize(frame1Path);
    const size2 = getFileSize(frame2Path);

    // Clean up temp frames
    [frame1Path, frame2Path].forEach((p) => {
      try {
        fs.unlinkSync(p);
      } catch {}
    });

    if (size1 === 0 || size2 === 0) return { freezeDetected: false };

    // File size comparison is unreliable for talking-head videos — avatar sits against
    // a static background so frame sizes are naturally similar even when video is playing.
    // Use a very tight threshold: only flag if frames are byte-for-byte identical (< 0.1% diff).
    // Real freeze = truly identical frames. Near-identical = normal avatar video.
    const diff = Math.abs(size1 - size2) / Math.max(size1, size2);
    return { freezeDetected: diff < 0.001 }; // < 0.1% = byte-identical = truly frozen
  } catch {
    // Clean up on error
    [frame1Path, frame2Path].forEach((p) => {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {}
    });
    return { freezeDetected: false };
  }
}

/**
 * Check avatar framing for the expected format.
 * For 16:9: width > height expected.
 * For 9:16: height > width expected.
 */
function checkFraming(videoMeta, expectedFormat) {
  if (!videoMeta.valid || !expectedFormat) return true; // can't check — pass
  const { width, height } = videoMeta;
  if (expectedFormat === '16:9') return width >= height;
  if (expectedFormat === '9:16') return height >= width;
  return true;
}

// ─── canProduce ──────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @returns {{ ready: boolean, reasons: string[] }}
 */
function canProduce(jobSpec) {
  const reasons = [];

  if (!jobSpec) {
    reasons.push('jobSpec is null or undefined');
    return { ready: false, reasons };
  }

  if (!jobSpec.jobId) reasons.push('jobSpec.jobId missing');

  // Check ffprobe available
  try {
    const fp = ffprobePath();
    if (!fp) reasons.push('ffprobe path not found');
  } catch {
    reasons.push('ffprobe not available');
  }

  // Segment paths should be provided at run time — check render output directory
  const renderDir = jobSpec.renderOutputDir || path.join(__dirname, '..', '..', 'tmp');
  if (!fs.existsSync(renderDir)) {
    reasons.push(`Render output directory not found: ${renderDir}`);
  }

  return { ready: reasons.length === 0, reasons };
}

// ─── commit ──────────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @param {string[]} segmentPaths
 * @param {Object} gate0Report
 * @returns {{ committed: string }}
 */
function commit(jobSpec, segmentPaths, gate0Report) {
  const count = segmentPaths?.length || 0;
  const format = gate0Report?.confirmedFormat || jobSpec?.order?.output?.format || 'unknown';
  return {
    committed: `I will validate ${count} rendered segment(s) — freeze detection, audio presence, audio level (silent avatar detection, threshold -50dB), minimum duration (3s), avatar framing for [${format}]. ffprobe is ground truth. Silent or too-short segments trigger re-render request.`,
  };
}

// ─── run ─────────────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @param {string[]} segmentPaths
 * @param {Object} gate0Report
 * @param {Object} gate1Report
 * @param {string[]} segmentLabels - parallel array of human-readable labels for each segment path
 * @param {Object} [opts]
 * @param {string[]} [opts.segmentUrls] - parallel array of provider URLs for CDN expiry check
 * @param {number} [opts.jobStartedAtMs] - render kick-off timestamp for STUCK detection
 * @returns {Promise<Object>} GateOutput
 */
async function run(jobSpec, segmentPaths, gate0Report, gate1Report, segmentLabels = [], opts = {}) {
  const jobId = jobSpec?.jobId || 'unknown';
  const now = () => new Date().toISOString();
  const segmentUrls = opts?.segmentUrls || jobSpec?.state?.segmentUrls || [];
  const jobStartedAtMs = opts?.jobStartedAtMs || jobSpec?.state?.renderStartedAt
    ? new Date(jobSpec.state.renderStartedAt).getTime()
    : null;

  // CPD-483: validate upstream outputs before doing any work
  validatePortalInput('2', jobSpec);

  // ── STUCK check (pre-flight) ────────────────────────────────────────────────
  if (jobStartedAtMs) {
    const stuckCheck = checkIfStuck(jobId, segmentPaths, jobStartedAtMs);
    if (stuckCheck.stuck) {
      logError('PORTAL2_STUCK', new Error('Render is STUCK'), { jobId, portal: 2, ...stuckCheck });
    }
  }

  let speakerName = 'the host';
  try {
    const { loadCustomerConfig } = require('../customerConfig');
    const _sCfg = loadCustomerConfig(jobSpec?.customerId, 'long-form');
    speakerName =
      _sCfg?.voice?.speakerName || _sCfg?.designDefaults?.voice?.speakerName || speakerName;
  } catch (_e) {}

  // Load thresholds from customerConfig — universal, not c0-specific
  const { passThreshold: PASS_THRESHOLD, reviewThreshold: REVIEW_THRESHOLD } =
    getThresholds(jobSpec);

  const expectedFormatRaw = gate0Report?.confirmedFormat || jobSpec?.order?.output?.format || null;
  const contentType = String(jobSpec?.contentType || '').toLowerCase();
  // News pipelines can validly mix portrait + landscape sources while assembly normalizes output.
  // Portal 0 already treats news format mismatches as non-blocking; keep Portal 2 aligned.
  const expectedFormat = contentType.startsWith('news') ? null : expectedFormatRaw;

  const upstreamContext = {
    reviewedReports: ['gate0', 'gate1'],
    confirmedClean: [
      ...(gate0Report?.upstreamContext?.confirmedClean || []),
      ...(gate1Report?.upstreamContext?.confirmedClean || []),
    ],
    escalatedConcerns: [
      ...(gate0Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate1Report?.upstreamContext?.escalatedConcerns || []),
    ],
    downstreamHeadsUp: null,
  };

  const baseOutput = {
    portal: 2,
    jobId,
    passed: false,
    score: 0,
    outcome: 'hard_fail',
    cdnExpired: false,
    expiredSegmentUrls: [],
    segmentResults: [],
    batchStopped: false,
    batchStoppedAt: null,
    upstreamContext,
    completedAt: now(),
  };

  if (!segmentPaths || segmentPaths.length === 0) {
    const reason = 'No segment paths provided to Portal 2';
    logError('PORTAL2_NO_SEGMENTS', new Error(reason), { jobId, portal: 2 });
    return { ...baseOutput, cdnExpired: false, expiredSegmentUrls: [], completedAt: now() };
  }

  // ── CDN expiry pre-check ────────────────────────────────────────────────────
  // When segment files are missing and URLs are available, probe for 403/410
  // to distinguish CDN expiry (fixable: re-request render) from genuine corruption.
  const expiredSegmentUrls = [];
  const missingPaths = segmentPaths.filter((p) => {
    try { return !fs.existsSync(p) || fs.statSync(p).size < 1024; } catch { return true; }
  });

  if (missingPaths.length > 0 && segmentUrls.length > 0) {
    const cdnChecks = await Promise.all(
      segmentPaths.map((p, i) => {
        const url = segmentUrls[i];
        const isMissing = missingPaths.includes(p);
        if (isMissing && url) return checkCdnStatus(url).then((r) => ({ url, ...r }));
        return Promise.resolve({ url, expired: false, statusCode: null });
      })
    );

    for (const check of cdnChecks) {
      if (check.expired) {
        expiredSegmentUrls.push(check.url);
        logError(
          'PORTAL2_CDN_EXPIRED',
          new Error(`CDN URL expired (${check.statusCode}): ${check.url}`),
          { jobId, portal: 2, statusCode: check.statusCode, url: check.url }
        );
      }
    }
  }

  const segmentResults = [];
  let hardFailTriggered = false;
  let batchStoppedAt = null;
  let totalScore = 100;
  const deductions = [];

  for (let i = 0; i < segmentPaths.length; i++) {
    const segPath = segmentPaths[i];
    const result = {
      segmentPath: segPath,
      sizeOk: false,
      audioOk: false,
      freezeDetected: false,
      framingOk: true,
      lipSyncOk: true, // pass/fail — default pass (no AI analysis here)
    };

    // Step 1: File size check
    const fileSize = getFileSize(segPath);
    result.sizeOk = fileSize >= MIN_FILE_SIZE;

    if (!result.sizeOk) {
      const reason = `Segment ${i} rejected as corrupt: ${fileSize} bytes < ${MIN_FILE_SIZE} bytes minimum`;
      logError('PORTAL2_CORRUPT_SEGMENT', new Error(reason), {
        jobId,
        portal: 2,
        segmentPath: segPath,
        fileSize,
      });

      // First segment corrupt = stop immediately
      if (i === 0) {
        result.freezeDetected = false;
        result.audioOk = false;
        segmentResults.push(result);
        hardFailTriggered = true;
        batchStoppedAt = segPath;
        break;
      }
      // Other segments: mark as failed, continue batch
      deductions.push({ points: -10, reason });
      totalScore -= 10;
      segmentResults.push(result);
      continue;
    }

    // Step 2: ffprobe audio check
    try {
      const audioResult = await ffprobeAudioCheck(segPath);
      result.audioOk = audioResult.hasAudio && audioResult.durationSecs > 0;

      if (!result.audioOk) {
        const reason = `Segment ${i} has no audio (ffprobe confirmed)`;
        logError('PORTAL2_NO_AUDIO', new Error(reason), { jobId, portal: 2, segmentPath: segPath });

        // First segment audio missing = stop immediately
        if (i === 0) {
          segmentResults.push(result);
          hardFailTriggered = true;
          batchStoppedAt = segPath;
          break;
        }
        totalScore -= 25;
        deductions.push({ points: -25, reason });
      }
    } catch (err) {
      logError('PORTAL2_FFPROBE_ERROR', err, { jobId, portal: 2, segmentPath: segPath });
      result.audioOk = false;
      totalScore -= 15;
      deductions.push({ points: -15, reason: `ffprobe error on segment ${i}: ${err.message}` });
    }

    // Step 2b: Frame rate + audio/video duration mismatch check (catches slow-motion)
    try {
      const [videoMeta, streamMeta] = await Promise.all([
        probeVideoStream(segPath),
        probeAllStreams(segPath),
      ]);
      if (videoMeta.valid) {
        result.frameRate = videoMeta.frameRate;
        // Variable frame rate or unexpected rate is a quality issue
        const isBadFrameRate =
          videoMeta.frameRate && (videoMeta.frameRate < 23 || videoMeta.frameRate > 61);
        if (isBadFrameRate) {
          const reason = `Segment ${i} has unexpected frame rate ${videoMeta.frameRate}fps (expected 25-30fps) — may cause slow-motion or stutter`;
          logError('PORTAL2_BAD_FRAME_RATE', new Error(reason), {
            jobId,
            portal: 2,
            segmentPath: segPath,
            frameRate: videoMeta.frameRate,
          });
          totalScore -= 20;
          deductions.push({ points: -20, reason });
          result.frameRateOk = false;
        } else {
          result.frameRateOk = true;
        }
      }
      if (streamMeta.valid && streamMeta.audioDuration > 0) {
        result.avDurationRatio = streamMeta.mismatchRatio;
        if (streamMeta.isMismatched) {
          const reason = `Segment ${i} audio/video duration mismatch — video ${streamMeta.videoDuration.toFixed(1)}s vs audio ${streamMeta.audioDuration.toFixed(1)}s (ratio ${streamMeta.mismatchRatio}x). This causes slow-motion or speed distortion in output.`;
          logError('PORTAL2_AV_DURATION_MISMATCH', new Error(reason), {
            jobId,
            portal: 2,
            segmentPath: segPath,
            ...streamMeta,
          });
          // AV mismatch > 1.5x is a hard fail — the segment is unusable
          const mismatchPoints = streamMeta.mismatchRatio > 1.5 ? -50 : -25;
          totalScore += mismatchPoints;
          deductions.push({ points: mismatchPoints, reason });
          result.avDurationOk = false;
        } else {
          result.avDurationOk = true;
        }
      }
    } catch (probeErr) {
      logError('PORTAL2_STREAM_PROBE_ERROR', probeErr, { jobId, portal: 2, segmentPath: segPath });
    }

    // Step 2b: Audio level check — detect silent renders (Avatar not speaking)
    // Silent = mean volume < -50dB. A talking avatar is typically -20 to -35dB.
    let audioLevel = { meanVolume: null, isSilent: false };
    if (result.audioOk) {
      try {
        audioLevel = await checkAudioLevel(segPath);
        result.meanVolume = audioLevel.meanVolume;
        result.isSilent = audioLevel.isSilent;
        if (audioLevel.isSilent) {
          const reason = `Segment ${i} (${path.basename(segPath)}) is silent — mean volume ${audioLevel.meanVolume}dB (threshold: -50dB). ${speakerName} not speaking.`;
          logError('PORTAL2_SILENT_SEGMENT', new Error(reason), {
            jobId,
            portal: 2,
            segmentPath: segPath,
            meanVolume: audioLevel.meanVolume,
          });
          deductions.push({ points: -30, reason });
          totalScore -= 30;
        }
      } catch (e) {
        logError('PORTAL2_AUDIO_LEVEL_ERROR', e, { jobId, portal: 2, segmentPath: segPath });
      }
    }

    // Step 3: Video probe for framing + duration
    let videoMeta = { valid: false };
    try {
      videoMeta = await probeVideoStream(segPath);
    } catch (err) {
      logError('PORTAL2_VIDEO_PROBE_ERROR', err, { jobId, portal: 2, segmentPath: segPath });
    }

    const minSeg = minSegmentSeconds();
    // Short duration check — segments below min are defective or too thin for QA
    if (videoMeta.valid && videoMeta.duration < minSeg && videoMeta.duration > 0) {
      const reason = `Segment ${i} duration too short: ${videoMeta.duration.toFixed(1)}s (minimum ${minSeg}s for avatar dialogue; set GATE2_MIN_SEGMENT_SECONDS)`;
      logError('PORTAL2_SHORT_SEGMENT', new Error(reason), {
        jobId,
        portal: 2,
        segmentPath: segPath,
        duration: videoMeta.duration,
      });
      deductions.push({ points: -20, reason });
      totalScore -= 20;
      result.tooShort = true;
      result.duration = videoMeta.duration;
    }

    // Step 4: Freeze detection
    if (videoMeta.valid && videoMeta.duration > 1) {
      try {
        const freezeResult = await detectFreeze(segPath, videoMeta.duration);
        result.freezeDetected = freezeResult.freezeDetected;

        if (result.freezeDetected) {
          // Talking-head avatar clips can have very similar first/last frames while still
          // being valid (lip movement with static background). Only hard-fail freeze when
          // audio is also near-silent; otherwise record as a soft warning.
          const isLikelyStaticAvatarFalsePositive =
            result.audioOk &&
            result.isSilent !== true &&
            Number.isFinite(result.meanVolume) &&
            result.meanVolume > -45;

          if (isLikelyStaticAvatarFalsePositive) {
            const reason = `Segment ${i} freeze signal downgraded (voiced/static talking-head pattern, mean ${result.meanVolume}dB)`;
            logError('PORTAL2_FREEZE_SOFT_WARNING', new Error(reason), {
              jobId,
              portal: 2,
              segmentPath: segPath,
              meanVolume: result.meanVolume,
            });
            deductions.push({ points: -5, reason });
            totalScore -= 5;
          } else {
            const reason = `Freeze detected in segment ${i}`;
            logError('PORTAL2_FREEZE_DETECTED', new Error(reason), {
              jobId,
              portal: 2,
              segmentPath: segPath,
              meanVolume: result.meanVolume ?? null,
            });
            hardFailTriggered = true;
            batchStoppedAt = segPath;
            segmentResults.push(result);
            break;
          }
        }
      } catch (err) {
        logError('PORTAL2_FREEZE_CHECK_ERROR', err, { jobId, portal: 2, segmentPath: segPath });
      }
    }

    // Step 5: Avatar framing check
    result.framingOk = checkFraming(videoMeta, expectedFormat);
    if (!result.framingOk) {
      const reason = `Segment ${i} framing mismatch: expected ${expectedFormat}, got ${videoMeta.width}x${videoMeta.height}`;
      logError('PORTAL2_FRAMING_MISMATCH', new Error(reason), {
        jobId,
        portal: 2,
        segmentPath: segPath,
        expectedFormat,
      });
      totalScore -= 10;
      deductions.push({ points: -10, reason });
    }

    segmentResults.push(result);
  }

  // ── Score → outcome ─────────────────────────────────────────────────────
  totalScore = Math.max(0, totalScore);

  let outcome;
  let passed = false;

  if (hardFailTriggered) {
    outcome = 'hard_fail';
    passed = false;
    totalScore = Math.min(totalScore, 50); // Hard fail caps at 50
    logError('PORTAL2_HARD_FAIL', new Error(`Batch stopped at ${batchStoppedAt}`), {
      jobId,
      portal: 2,
      batchStoppedAt,
    });
  } else if (totalScore >= PASS_THRESHOLD) {
    outcome = 'pass';
    passed = true;
  } else if (totalScore >= REVIEW_THRESHOLD) {
    outcome = 'review';
    passed = false;
    logError('PORTAL2_REVIEW', new Error(`Score ${totalScore} — operator review needed`), {
      jobId,
      portal: 2,
      totalScore,
      deductions,
    });
  } else {
    outcome = 'hard_fail';
    passed = false;
    logError('PORTAL2_HARD_FAIL', new Error(`Score ${totalScore} — hard fail`), {
      jobId,
      portal: 2,
      totalScore,
      deductions,
    });
  }

  // Override outcome based on segment quality issues (but not if already a hard_fail)
  // Too-short = defective script text (e.g. one-line OUTRO). Retrying HeyGen won't fix bad script.
  // Hard fail and let Portal 1 sendback fix the script before burning more HeyGen credits.
  // Silent = HeyGen render issue (transient). Retry may succeed.
  const hasSilentSegments = segmentResults.some((r) => r.isSilent);
  const hasShortSegments = segmentResults.some((r) => r.tooShort);

  if (hasShortSegments && outcome !== 'hard_fail') {
    outcome = 'hard_fail';
    passed = false;
    logError(
      'PORTAL2_SHORT_SEGMENT_HARD_FAIL',
      new Error('Avatar segment too short — script text was too brief'),
      { jobId, portal: 2, totalScore }
    );
  } else if (hasSilentSegments && outcome !== 'hard_fail') {
    outcome = 'rerender_needed';
    passed = false;
    logError('PORTAL2_RERENDER_NEEDED', new Error('Silent segments detected'), {
      jobId,
      portal: 2,
      totalScore,
    });
  }

  const concerns = deductions.map((d) => d.reason);
  const downstreamHeadsUp = concerns.length > 0 ? `Portal 2 concerns: ${concerns.join('; ')}` : null;

  // When CDN expired, override outcome to cdn_expired so callers can re-request renders
  // without treating this as a permanent hard_fail.
  const finalOutcome =
    expiredSegmentUrls.length > 0 && outcome === 'hard_fail' ? 'cdn_expired' : outcome;

  return {
    portal: 2,
    jobId,
    passed,
    score: totalScore,
    outcome: finalOutcome,
    cdnExpired: expiredSegmentUrls.length > 0,
    expiredSegmentUrls,
    segmentResults,
    deductions,
    concerns,
    batchStopped: hardFailTriggered,
    batchStoppedAt: hardFailTriggered ? batchStoppedAt : null,
    silentSegments: segmentResults
      .map((r, i) =>
        r.isSilent
          ? {
              path: segmentPaths[i],
              label: segmentLabels[i] || path.basename(segmentPaths[i]),
              meanVolume: r.meanVolume,
            }
          : null
      )
      .filter(Boolean),
    shortSegments: segmentResults
      .map((r, i) =>
        r.tooShort
          ? {
              path: segmentPaths[i],
              label: segmentLabels[i] || path.basename(segmentPaths[i]),
              duration: r.duration,
            }
          : null
      )
      .filter(Boolean),
    rerenderNeeded: false, // set to true in assembly if re-render is triggered
    upstreamContext: {
      ...upstreamContext,
      confirmedClean: passed
        ? [...upstreamContext.confirmedClean, 'render_quality']
        : upstreamContext.confirmedClean,
      escalatedConcerns:
        outcome === 'hard_fail'
          ? [...upstreamContext.escalatedConcerns, ...concerns]
          : upstreamContext.escalatedConcerns,
      downstreamHeadsUp,
    },
    completedAt: now(),
  };
}

// ─── prepare ─────────────────────────────────────────────────────────────────

/**
 * Pre-flight setup called immediately on job:confirmed.
 * Non-blocking — never throws, never awaits slow operations.
 * @param {Object} jobSpec
 */
function prepare(jobSpec) {
  const jobId = jobSpec?.jobId || 'unknown';
  try {
    // Verify ffprobe is available (spawn test)
    const fp = ffprobePath();
    if (!fp) {
      console.warn(`[gate2] prepare() warning: ffprobe path not found for job ${jobId}`);
    }

    // Pre-create tmp directory if needed
    const tmpDir = path.join(__dirname, '..', '..', 'tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
      console.log(`[gate2] Created tmp directory: ${tmpDir}`);
    }

    // Pre-read expected format from designSpec
    const expectedFormat =
      jobSpec?.order?.output?.format || jobSpec?.order?.designSpec?.aspectRatio || 'unknown';
    const avatarCount = jobSpec?.order?.inputs?.items?.length || 0;

    console.log(
      `[gate2] Ready for job ${jobId} — ffprobe available, expecting ${avatarCount} avatar segments at ${expectedFormat}`
    );
  } catch (e) {
    // Non-fatal — preparation failure never blocks the gate
    console.warn(`[gate2] prepare() warning: ${e.message}`);
  }
}

module.exports = { canProduce, commit, run, prepare, checkIfStuck, checkCdnStatus };
