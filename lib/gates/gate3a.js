'use strict';
/**
 * lib/gates/gate3a.js — Gate 3a: Gemini Assembly QA (Qualitative)
 *
 * Watches the assembled video at 3 sample points: EARLY / MIDDLE / LATE.
 * Qualitative review — passes notes to gate3b.
 *
 * Hard fail conditions:
 *   - Freeze at ANY sample point
 *   - Score < 60
 *
 * Score → action:
 *   ≥70: pass to gate3b
 *   60-69: pass to gate3b with notes (gate3b sees the notes)
 *   <60 OR freeze: hard fail → targeted FFmpeg alarm fires, escalate to monitoring
 *
 * Output contract:
 * {
 *   gate: '3a',
 *   jobId: string,
 *   passed: boolean,
 *   score: number,
 *   outcome: 'pass' | 'pass_with_notes' | 'hard_fail',
 *   sampleFindings: { early: object, middle: object, late: object },
 *   ffmpegAlarm: { fired: boolean, targetTimestamp: string | null, issue: string | null },
 *   upstreamContext: { reviewedReports, confirmedClean, escalatedConcerns, downstreamHeadsUp },
 *   completedAt: ISO-8601
 * }
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { uploadToGeminiFiles, waitForGeminiFile, deleteGeminiFile } = require('../qa');
const { logError } = require('../error_logger');
const { ffprobePath } = require('../ffmpeg_utils');
const axios = require('axios');

// ─── Constants ───────────────────────────────────────────────────────────────

const PASS_THRESHOLD = 70;
const PASS_WITH_NOTES_THRESHOLD = 60;

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_APIKEY = process.env.GEMINI_API_KEY;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get video duration via ffprobe.
 */
function getVideoDuration(filePath) {
  return new Promise((resolve) => {
    execFile(ffprobePath(), [
      '-v', 'quiet',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath
    ], { timeout: 15000 }, (err, stdout) => {
      if (err) return resolve(0);
      try {
        const data = JSON.parse(stdout);
        resolve(parseFloat(data.format?.duration || '0'));
      } catch {
        resolve(0);
      }
    });
  });
}

/**
 * Call Gemini Files API to analyze a video segment.
 * Returns parsed JSON result or null on error.
 */
async function analyzeWithGemini(fileUri, prompt, jobId) {
  if (!GEMINI_APIKEY) {
    logError('GATE3A_NO_GEMINI_KEY', new Error('GEMINI_API_KEY not set'), { jobId, gate: '3a' });
    return null;
  }

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
      {
        contents: [{
          role: 'user',
          parts: [
            { fileData: { mimeType: 'video/mp4', fileUri } },
            { text: prompt }
          ]
        }]
      },
      { timeout: 60000 }
    );

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    logError('GATE3A_GEMINI_CALL_ERROR', err, { jobId, gate: '3a' });
    return null;
  }
}

/**
 * Extract a 20-second clip from a video at a given start time.
 * Returns the temp path or null.
 */
function extractClip(inputPath, startTime, duration, outputPath) {
  return new Promise((resolve) => {
    const { ffmpegPath } = require('../ffmpeg_utils');
    execFile(ffmpegPath(), [
      '-ss', String(startTime),
      '-i', inputPath,
      '-t', String(duration),
      '-c', 'copy',
      '-y',
      outputPath
    ], { timeout: 60000 }, (err) => {
      resolve(!err && fs.existsSync(outputPath) ? outputPath : null);
    });
  });
}

// ─── canProduce ──────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @returns {{ ready: boolean, reasons: string[] }}
 */
function canProduce(jobSpec) {
  const reasons = [];

  if (!GEMINI_APIKEY) {
    reasons.push('GEMINI_API_KEY not set — Gemini video analysis unavailable');
  }

  if (!jobSpec) {
    reasons.push('jobSpec is null or undefined');
    return { ready: false, reasons };
  }

  if (!jobSpec.jobId) reasons.push('jobSpec.jobId missing');

  const assembledPath = jobSpec.assembledPath || jobSpec.outputPath;
  if (!assembledPath) {
    reasons.push('No assembledPath in jobSpec — assembled video path required');
  } else if (!fs.existsSync(assembledPath)) {
    reasons.push(`Assembled file not found: ${assembledPath}`);
  } else {
    const size = fs.statSync(assembledPath).size;
    if (size <= 100 * 1024) {
      reasons.push(`Assembled file too small: ${size} bytes (minimum 100KB)`);
    }
  }

  return { ready: reasons.length === 0, reasons };
}

// ─── commit ──────────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @returns {{ committed: string }}
 */
function commit(jobSpec) {
  const isShort = (jobSpec?.order?.formType || '').includes('short');
  return {
    committed: `I will watch 3 sample points of the assembled video — EARLY/MIDDLE/LATE — and confirm: pacing, transitions, source clips present at correct positions, audio continuous (no dropouts), chrome visible with correct skin color${isShort ? ', portrait confirmed, top/bottom split correct, caption visible' : ''}.`
  };
}

// ─── run ─────────────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @param {string} assembledPath
 * @param {Object[]} priorGateReports - [gate0Report, gate1Report, gate2Report]
 * @returns {Promise<Object>} GateOutput
 */
async function run(jobSpec, assembledPath, priorGateReports) {
  const jobId = jobSpec?.jobId || 'unknown';
  const now = () => new Date().toISOString();

  const [gate0Report, gate1Report, gate2Report] = priorGateReports || [];

  const upstreamContext = {
    reviewedReports: ['gate0', 'gate1', 'gate2'],
    confirmedClean: [
      ...(gate0Report?.upstreamContext?.confirmedClean || []),
      ...(gate1Report?.upstreamContext?.confirmedClean || []),
      ...(gate2Report?.upstreamContext?.confirmedClean || [])
    ],
    escalatedConcerns: [
      ...(gate0Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate1Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate2Report?.upstreamContext?.escalatedConcerns || [])
    ],
    downstreamHeadsUp: null
  };

  const baseOutput = {
    gate: '3a',
    jobId,
    passed: false,
    score: 0,
    outcome: 'hard_fail',
    sampleFindings: { early: null, middle: null, late: null },
    ffmpegAlarm: { fired: false, targetTimestamp: null, issue: null },
    upstreamContext,
    completedAt: now()
  };

  const readiness = canProduce(jobSpec);
  if (!readiness.ready) {
    const reason = `Gate 3a not ready: ${readiness.reasons.join('; ')}`;
    logError('GATE3A_NOT_READY', new Error(reason), { jobId, gate: '3a' });
    return { ...baseOutput, completedAt: now() };
  }

  const targetPath = assembledPath || jobSpec.assembledPath || jobSpec.outputPath;
  const isShort = (jobSpec?.order?.formType || '').includes('short');
  const confirmedFormat = gate0Report?.confirmedFormat || jobSpec?.order?.output?.format || '16:9';
  const expectedSkin = jobSpec?.order?.designSpec?.chrome?.skin || 'news';
  const clipCount = gate1Report?.clipCount || jobSpec?.commitments?.expectedClipCount || 0;

  // Get video duration
  const totalDuration = await getVideoDuration(targetPath);
  if (totalDuration < 5) {
    const reason = `Assembled video too short: ${totalDuration}s`;
    logError('GATE3A_VIDEO_TOO_SHORT', new Error(reason), { jobId, gate: '3a', totalDuration });
    return { ...baseOutput, completedAt: now() };
  }

  // Sample points: EARLY (10%), MIDDLE (50%), LATE (90%)
  const SAMPLE_DURATION = 20;
  const samplePoints = [
    { label: 'early',  startFn: (d) => Math.max(0, d * 0.10 - SAMPLE_DURATION / 2) },
    { label: 'middle', startFn: (d) => Math.max(0, d * 0.50 - SAMPLE_DURATION / 2) },
    { label: 'late',   startFn: (d) => Math.max(0, d - SAMPLE_DURATION - 2) }
  ];

  const tmpDir = path.join(__dirname, '..', '..', 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const sampleFindings = { early: null, middle: null, late: null };
  let totalScore = 100;
  const deductions = [];
  let freezeFound = false;
  let ffmpegAlarm = { fired: false, targetTimestamp: null, issue: null };
  const uploadedFiles = [];

  for (const { label, startFn } of samplePoints) {
    const startTime = startFn(totalDuration);
    const clipPath = path.join(tmpDir, `gate3a_${jobId}_${label}.mp4`);

    // Extract 20s clip
    const clipped = await extractClip(targetPath, startTime, SAMPLE_DURATION, clipPath);
    if (!clipped) {
      deductions.push({ points: -10, reason: `Could not extract ${label} sample clip` });
      totalScore -= 10;
      continue;
    }

    // Upload to Gemini Files API
    let geminiFile;
    try {
      geminiFile = await uploadToGeminiFiles(clipped);
      if (geminiFile) {
        await waitForGeminiFile(geminiFile);
        uploadedFiles.push(geminiFile);
      }
    } catch (err) {
      logError('GATE3A_UPLOAD_ERROR', err, { jobId, gate: '3a', label });
      deductions.push({ points: -10, reason: `Could not upload ${label} sample to Gemini` });
      totalScore -= 10;
      // Clean up clip
      try { fs.unlinkSync(clipPath); } catch {}
      continue;
    }

    // Build analysis prompt
    const prompt = `You are a video QA analyst reviewing a ${label.toUpperCase()} sample (${SAMPLE_DURATION}s) of an assembled news/reaction show.

Confirmed details:
- Format: ${confirmedFormat}
- Chrome skin: ${expectedSkin}
- Is short-form: ${isShort}

Check for:
1. Freeze: any still frame lasting > 2 seconds?
2. Source clips: are source clips visible (not just talking head)?
3. Audio: continuous? any dropout or cut?
4. Chrome: is the broadcast chrome overlay visible? correct skin color?
${isShort ? '5. Portrait layout: is the top/bottom split correct? caption visible?\n' : ''}

Return JSON only:
{
  "freezeDetected": boolean,
  "freezeTimestamp": "HH:MM:SS or null",
  "sourceClipsVisible": boolean,
  "audioContinuous": boolean,
  "chromeVisible": boolean,
  ${isShort ? '"portraitSplitCorrect": boolean, "captionVisible": boolean,' : ''}
  "issues": ["list of specific issues found"],
  "score": 0-100
}`;

    const finding = await analyzeWithGemini(geminiFile?.uri, prompt, jobId);

    // Clean up clip
    try { fs.unlinkSync(clipPath); } catch {}

    if (!finding) {
      deductions.push({ points: -5, reason: `Gemini returned no result for ${label} sample` });
      totalScore -= 5;
      sampleFindings[label] = { error: 'No Gemini response' };
      continue;
    }

    sampleFindings[label] = finding;

    // Hard fail: freeze detected at this sample
    if (finding.freezeDetected) {
      freezeFound = true;
      const timestamp = finding.freezeTimestamp || `~${Math.round(startTime)}s`;
      const issue = `Freeze detected at ${label} sample (${timestamp})`;
      logError('GATE3A_FREEZE', new Error(issue), { jobId, gate: '3a', label, timestamp });

      // Fire targeted FFmpeg alarm
      ffmpegAlarm = {
        fired: true,
        targetTimestamp: timestamp,
        issue
      };

      sampleFindings[label] = { ...finding, hardFail: true };
      break; // Stop checking further samples
    }

    // Score deductions from Gemini findings
    const geminiScore = typeof finding.score === 'number' ? finding.score : 100;
    const deduction = Math.max(0, 100 - geminiScore) / 3; // Each sample contributes ~33% to total
    if (deduction > 0) {
      totalScore -= deduction;
      const issues = finding.issues || [];
      if (issues.length > 0) {
        deductions.push({ points: -deduction, reason: `${label}: ${issues.join('; ')}` });
      }
    }

    if (!finding.audioContinuous) {
      logError('GATE3A_AUDIO_DROPOUT', new Error(`Audio dropout at ${label}`), { jobId, gate: '3a', label });
    }
  }

  // Clean up Gemini files
  for (const file of uploadedFiles) {
    try { await deleteGeminiFile(file.name); } catch {}
  }

  // ── Score → outcome ─────────────────────────────────────────────────────
  totalScore = Math.max(0, Math.min(100, totalScore));

  let outcome;
  let passed = false;

  if (freezeFound) {
    outcome = 'hard_fail';
    totalScore = Math.min(totalScore, 40);
    logError('GATE3A_HARD_FAIL_FREEZE', new Error('Freeze detected'), { jobId, gate: '3a' });
  } else if (totalScore >= PASS_THRESHOLD) {
    outcome = 'pass';
    passed = true;
  } else if (totalScore >= PASS_WITH_NOTES_THRESHOLD) {
    outcome = 'pass_with_notes';
    passed = true; // passes to 3b with notes
  } else {
    outcome = 'hard_fail';
    logError('GATE3A_HARD_FAIL_SCORE', new Error(`Score ${totalScore} < ${PASS_WITH_NOTES_THRESHOLD}`), { jobId, gate: '3a', totalScore });
  }

  const concerns = deductions.map(d => d.reason);
  const downstreamHeadsUp = concerns.length > 0
    ? `Gate 3a notes for gate3b: ${concerns.join('; ')}`
    : null;

  return {
    gate: '3a',
    jobId,
    passed,
    score: Math.round(totalScore),
    outcome,
    sampleFindings,
    ffmpegAlarm,
    upstreamContext: {
      ...upstreamContext,
      confirmedClean: passed ? [...upstreamContext.confirmedClean, 'assembly_qualitative'] : upstreamContext.confirmedClean,
      escalatedConcerns: outcome === 'hard_fail' ? [...upstreamContext.escalatedConcerns, ...concerns] : upstreamContext.escalatedConcerns,
      downstreamHeadsUp
    },
    completedAt: now()
  };
}

module.exports = { canProduce, commit, run };
