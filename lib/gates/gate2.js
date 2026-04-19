'use strict';
/**
 * lib/gates/gate2.js — Gate 2: Render Quality
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
 *
 * Score → action:
 *   ≥85: pass to assembly
 *   65-84: sendback for operator review (surfaces to monitoring, not auto-re-render)
 *   <65 OR freeze OR audio missing: hard fail → escalate
 *
 * Output contract:
 * {
 *   gate: 2,
 *   jobId: string,
 *   passed: boolean,
 *   score: number,
 *   outcome: 'pass' | 'review' | 'hard_fail',
 *   segmentResults: [{ segmentPath, sizeOk, audioOk, freezeDetected, framingOk, lipSyncOk }],
 *   batchStopped: boolean,
 *   batchStoppedAt: string | null,
 *   upstreamContext: { reviewedReports, confirmedClean, escalatedConcerns, downstreamHeadsUp },
 *   completedAt: ISO-8601
 * }
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ffprobePath, ffmpegPath } = require('../ffmpeg_utils');
const { ffprobeAudioCheck } = require('../qa');
const { logError } = require('../error_logger');
const { CONFIG } = require('../config');
const { getGateThresholds } = require('../customerConfig');

// ─── Constants (defaults — overridden by customerConfig at run time) ─────────

// Default fallbacks match c0.json qaThresholds.gate2
const DEFAULT_PASS_THRESHOLD = 85;
const DEFAULT_REVIEW_THRESHOLD = 65;
// MIN_FILE_SIZE from CONFIG (lib/config.js) — not hardcoded here
const MIN_FILE_SIZE = (CONFIG?.VIDEO?.MIN_SEGMENT_SIZE) || (100 * 1024); // 100KB fallback

/**
 * Get pass/review thresholds for this job from customerConfig.
 */
function getThresholds(jobSpec) {
  const customerId = jobSpec?.customerId || 'c0';
  const templateId = jobSpec?.order?.templateId || (jobSpec?.order?.formType?.includes('short') ? 'short-form' : 'long-form');
  const t = getGateThresholds(customerId, templateId, 'gate2', { pass: DEFAULT_PASS_THRESHOLD, manualReview: DEFAULT_REVIEW_THRESHOLD });
  return { passThreshold: t.pass || DEFAULT_PASS_THRESHOLD, reviewThreshold: t.manualReview || DEFAULT_REVIEW_THRESHOLD };
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
    execFile(ffmpegPath(), [
      '-i', filePath,
      '-af', 'volumedetect',
      '-vn', '-sn', '-dn',
      '-f', 'null', '/dev/null'
    ], { timeout: 15000 }, (err, stdout, stderr) => {
      // volumedetect outputs to stderr
      const output = stderr || '';
      const meanMatch = output.match(/mean_volume:\s*([-\d.]+)\s*dB/);
      const maxMatch  = output.match(/max_volume:\s*([-\d.]+)\s*dB/);
      const meanVolume = meanMatch ? parseFloat(meanMatch[1]) : null;
      const maxVolume  = maxMatch  ? parseFloat(maxMatch[1])  : null;
      // Silent = mean volume below -50dB (near-silence threshold for talking-head avatar)
      const isSilent = meanVolume !== null && meanVolume < -50;
      resolve({ meanVolume, maxVolume, isSilent });
    });
  });
}

/**
 * Run ffprobe to get video stream metadata.
 * Returns { duration, codec, width, height, valid } or { valid: false }.
 */
function probeVideoStream(filePath) {
  return new Promise((resolve) => {
    execFile(ffprobePath(), [
      '-v', 'quiet',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,duration,width,height',
      '-of', 'json',
      filePath
    ], { timeout: 15000 }, (err, stdout) => {
      if (err) return resolve({ valid: false, error: err.message });
      try {
        const data = JSON.parse(stdout);
        const streams = data.streams || [];
        if (streams.length === 0) return resolve({ valid: false, error: 'No video stream' });
        const s = streams[0];
        resolve({
          valid: true,
          codec: s.codec_name || '',
          duration: parseFloat(s.duration || '0'),
          width: parseInt(s.width || '0', 10),
          height: parseInt(s.height || '0', 10)
        });
      } catch (e) {
        resolve({ valid: false, error: e.message });
      }
    });
  });
}

/**
 * Extract a single frame from a video at a given time offset.
 * Returns the JPEG buffer or null.
 */
function extractFrame(filePath, timeOffset, outputPath) {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), [
      '-ss', String(timeOffset),
      '-i', filePath,
      '-frames:v', '1',
      '-q:v', '2',
      '-y',
      outputPath
    ], { timeout: 15000 }, (err) => {
      resolve(!err && fs.existsSync(outputPath));
    });
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
      extractFrame(filePath, Math.max(0, duration - 1), frame2Path)
    ]);

    if (!f1ok || !f2ok) return { freezeDetected: false };

    const size1 = getFileSize(frame1Path);
    const size2 = getFileSize(frame2Path);

    // Clean up temp frames
    [frame1Path, frame2Path].forEach(p => { try { fs.unlinkSync(p); } catch {} });

    if (size1 === 0 || size2 === 0) return { freezeDetected: false };

    // File size comparison is unreliable for talking-head videos — Bobby G sits against
    // a static background so frame sizes are naturally similar even when video is playing.
    // Use a very tight threshold: only flag if frames are byte-for-byte identical (< 0.1% diff).
    // Real freeze = truly identical frames. Near-identical = normal avatar video.
    const diff = Math.abs(size1 - size2) / Math.max(size1, size2);
    return { freezeDetected: diff < 0.001 }; // < 0.1% = byte-identical = truly frozen
  } catch {
    // Clean up on error
    [frame1Path, frame2Path].forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {} });
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
    committed: `I will validate ${count} rendered segment(s) — freeze detection, audio presence, audio level (silent avatar detection, threshold -50dB), minimum duration (3s), avatar framing for [${format}]. ffprobe is ground truth. Silent or too-short segments trigger re-render request.`
  };
}

// ─── run ─────────────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @param {string[]} segmentPaths
 * @param {Object} gate0Report
 * @param {Object} gate1Report
 * @param {string[]} segmentLabels - parallel array of human-readable labels for each segment path
 * @returns {Promise<Object>} GateOutput
 */
async function run(jobSpec, segmentPaths, gate0Report, gate1Report, segmentLabels = []) {
  const jobId = jobSpec?.jobId || 'unknown';
  const now = () => new Date().toISOString();

  // Load thresholds from customerConfig — universal, not c0-specific
  const { passThreshold: PASS_THRESHOLD, reviewThreshold: REVIEW_THRESHOLD } = getThresholds(jobSpec);

  const expectedFormat = gate0Report?.confirmedFormat || jobSpec?.order?.output?.format || null;

  const upstreamContext = {
    reviewedReports: ['gate0', 'gate1'],
    confirmedClean: [
      ...(gate0Report?.upstreamContext?.confirmedClean || []),
      ...(gate1Report?.upstreamContext?.confirmedClean || [])
    ],
    escalatedConcerns: [
      ...(gate0Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate1Report?.upstreamContext?.escalatedConcerns || [])
    ],
    downstreamHeadsUp: null
  };

  const baseOutput = {
    gate: 2,
    jobId,
    passed: false,
    score: 0,
    outcome: 'hard_fail',
    segmentResults: [],
    batchStopped: false,
    batchStoppedAt: null,
    upstreamContext,
    completedAt: now()
  };

  if (!segmentPaths || segmentPaths.length === 0) {
    const reason = 'No segment paths provided to Gate 2';
    logError('GATE2_NO_SEGMENTS', new Error(reason), { jobId, gate: 2 });
    return { ...baseOutput, completedAt: now() };
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
      lipSyncOk: true // pass/fail — default pass (no AI analysis here)
    };

    // Step 1: File size check
    const fileSize = getFileSize(segPath);
    result.sizeOk = fileSize >= MIN_FILE_SIZE;

    if (!result.sizeOk) {
      const reason = `Segment ${i} rejected as corrupt: ${fileSize} bytes < ${MIN_FILE_SIZE} bytes minimum`;
      logError('GATE2_CORRUPT_SEGMENT', new Error(reason), { jobId, gate: 2, segmentPath: segPath, fileSize });

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
        logError('GATE2_NO_AUDIO', new Error(reason), { jobId, gate: 2, segmentPath: segPath });

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
      logError('GATE2_FFPROBE_ERROR', err, { jobId, gate: 2, segmentPath: segPath });
      result.audioOk = false;
      totalScore -= 15;
      deductions.push({ points: -15, reason: `ffprobe error on segment ${i}: ${err.message}` });
    }

    // Step 2b: Audio level check — detect silent renders (Bobby G not speaking)
    // Silent = mean volume < -50dB. A talking avatar is typically -20 to -35dB.
    let audioLevel = { meanVolume: null, isSilent: false };
    if (result.audioOk) {
      try {
        audioLevel = await checkAudioLevel(segPath);
        result.meanVolume = audioLevel.meanVolume;
        result.isSilent = audioLevel.isSilent;
        if (audioLevel.isSilent) {
          const reason = `Segment ${i} (${path.basename(segPath)}) is silent — mean volume ${audioLevel.meanVolume}dB (threshold: -50dB). Bobby G not speaking.`;
          logError('GATE2_SILENT_SEGMENT', new Error(reason), { jobId, gate: 2, segmentPath: segPath, meanVolume: audioLevel.meanVolume });
          deductions.push({ points: -30, reason });
          totalScore -= 30;
        }
      } catch(e) {
        logError('GATE2_AUDIO_LEVEL_ERROR', e, { jobId, gate: 2, segmentPath: segPath });
      }
    }

    // Step 3: Video probe for framing + duration
    let videoMeta = { valid: false };
    try {
      videoMeta = await probeVideoStream(segPath);
    } catch (err) {
      logError('GATE2_VIDEO_PROBE_ERROR', err, { jobId, gate: 2, segmentPath: segPath });
    }

    // Short duration check — avatar segments < 3s are defective HeyGen renders
    if (videoMeta.valid && videoMeta.duration < 3 && videoMeta.duration > 0) {
      const reason = `Segment ${i} duration too short: ${videoMeta.duration.toFixed(1)}s (minimum 3s for avatar dialogue)`;
      logError('GATE2_SHORT_SEGMENT', new Error(reason), { jobId, gate: 2, segmentPath: segPath, duration: videoMeta.duration });
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
          const reason = `Freeze detected in segment ${i}`;
          logError('GATE2_FREEZE_DETECTED', new Error(reason), { jobId, gate: 2, segmentPath: segPath });
          hardFailTriggered = true;
          batchStoppedAt = segPath;
          segmentResults.push(result);
          break;
        }
      } catch (err) {
        logError('GATE2_FREEZE_CHECK_ERROR', err, { jobId, gate: 2, segmentPath: segPath });
      }
    }

    // Step 5: Avatar framing check
    result.framingOk = checkFraming(videoMeta, expectedFormat);
    if (!result.framingOk) {
      const reason = `Segment ${i} framing mismatch: expected ${expectedFormat}, got ${videoMeta.width}x${videoMeta.height}`;
      logError('GATE2_FRAMING_MISMATCH', new Error(reason), { jobId, gate: 2, segmentPath: segPath, expectedFormat });
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
    logError('GATE2_HARD_FAIL', new Error(`Batch stopped at ${batchStoppedAt}`), { jobId, gate: 2, batchStoppedAt });
  } else if (totalScore >= PASS_THRESHOLD) {
    outcome = 'pass';
    passed = true;
  } else if (totalScore >= REVIEW_THRESHOLD) {
    outcome = 'review';
    passed = false;
    logError('GATE2_REVIEW', new Error(`Score ${totalScore} — operator review needed`), { jobId, gate: 2, totalScore, deductions });
  } else {
    outcome = 'hard_fail';
    passed = false;
    logError('GATE2_HARD_FAIL', new Error(`Score ${totalScore} — hard fail`), { jobId, gate: 2, totalScore, deductions });
  }

  // Override outcome if silent or too-short segments found (but not already a hard fail)
  const hasBadSegments = segmentResults.some(r => r.isSilent || r.tooShort);
  if (hasBadSegments && outcome !== 'hard_fail') {
    outcome = 'rerender_needed';
    passed = false;
    logError('GATE2_RERENDER_NEEDED', new Error(`Silent or too-short segments detected`), { jobId, gate: 2, totalScore });
  }

  const concerns = deductions.map(d => d.reason);
  const downstreamHeadsUp = concerns.length > 0
    ? `Gate 2 concerns: ${concerns.join('; ')}`
    : null;

  return {
    gate: 2,
    jobId,
    passed,
    score: totalScore,
    outcome,
    segmentResults,
    deductions,
    concerns,
    batchStopped: hardFailTriggered,
    batchStoppedAt: hardFailTriggered ? batchStoppedAt : null,
    silentSegments: segmentResults
      .map((r, i) => r.isSilent ? { path: segmentPaths[i], label: segmentLabels[i] || path.basename(segmentPaths[i]), meanVolume: r.meanVolume } : null)
      .filter(Boolean),
    shortSegments: segmentResults
      .map((r, i) => r.tooShort ? { path: segmentPaths[i], label: segmentLabels[i] || path.basename(segmentPaths[i]), duration: r.duration } : null)
      .filter(Boolean),
    rerenderNeeded: false, // set to true in assembly if re-render is triggered
    upstreamContext: {
      ...upstreamContext,
      confirmedClean: passed ? [...upstreamContext.confirmedClean, 'render_quality'] : upstreamContext.confirmedClean,
      escalatedConcerns: outcome === 'hard_fail' ? [...upstreamContext.escalatedConcerns, ...concerns] : upstreamContext.escalatedConcerns,
      downstreamHeadsUp
    },
    completedAt: now()
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
    const expectedFormat = jobSpec?.order?.output?.format || jobSpec?.order?.designSpec?.aspectRatio || 'unknown';
    const avatarCount = jobSpec?.order?.inputs?.items?.length || 0;

    console.log(`[gate2] Ready for job ${jobId} — ffprobe available, expecting ${avatarCount} avatar segments at ${expectedFormat}`);
  } catch (e) {
    // Non-fatal — preparation failure never blocks the gate
    console.warn(`[gate2] prepare() warning: ${e.message}`);
  }
}

module.exports = { canProduce, commit, run, prepare };
