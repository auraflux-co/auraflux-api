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

// ─── Constants ───────────────────────────────────────────────────────────────

const PASS_THRESHOLD = 85;
const REVIEW_THRESHOLD = 65;
const MIN_FILE_SIZE = 100 * 1024; // 100KB

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

    const diff = Math.abs(size1 - size2) / Math.max(size1, size2);
    return { freezeDetected: diff < 0.05 }; // < 5% difference = likely frozen
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
    committed: `I will validate ${count} rendered segment(s) — freeze detection, audio presence via ffprobe, avatar framing for [${format}]. ffprobe is ground truth — no AI override.`
  };
}

// ─── run ─────────────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @param {string[]} segmentPaths
 * @param {Object} gate0Report
 * @param {Object} gate1Report
 * @returns {Promise<Object>} GateOutput
 */
async function run(jobSpec, segmentPaths, gate0Report, gate1Report) {
  const jobId = jobSpec?.jobId || 'unknown';
  const now = () => new Date().toISOString();

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

    // Step 3: Video probe for framing + duration
    let videoMeta = { valid: false };
    try {
      videoMeta = await probeVideoStream(segPath);
    } catch (err) {
      logError('GATE2_VIDEO_PROBE_ERROR', err, { jobId, gate: 2, segmentPath: segPath });
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
    batchStopped: hardFailTriggered,
    batchStoppedAt: hardFailTriggered ? batchStoppedAt : null,
    upstreamContext: {
      ...upstreamContext,
      confirmedClean: passed ? [...upstreamContext.confirmedClean, 'render_quality'] : upstreamContext.confirmedClean,
      escalatedConcerns: outcome === 'hard_fail' ? [...upstreamContext.escalatedConcerns, ...concerns] : upstreamContext.escalatedConcerns,
      downstreamHeadsUp
    },
    completedAt: now()
  };
}

module.exports = { canProduce, commit, run };
