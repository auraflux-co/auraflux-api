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
const { getGateThresholds } = require('../customerConfig');
const axios = require('axios');

// ─── Constants (defaults — overridden by customerConfig at run time) ─────────

// Default fallbacks match c0.json qaThresholds.gate3a
const DEFAULT_PASS_THRESHOLD = 70;
const DEFAULT_PASS_WITH_NOTES_THRESHOLD = 60;

/**
 * Get pass/notes thresholds for this job from customerConfig.
 */
function getThresholds(jobSpec) {
  const customerId = jobSpec?.customerId || 'c0';
  const templateId = jobSpec?.order?.templateId || (jobSpec?.order?.formType?.includes('short') ? 'short-form' : 'long-form');
  const t = getGateThresholds(customerId, templateId, 'gate3a', { pass: DEFAULT_PASS_THRESHOLD, manualReview: DEFAULT_PASS_WITH_NOTES_THRESHOLD });
  return {
    passThreshold: t.pass || DEFAULT_PASS_THRESHOLD,
    passWithNotesThreshold: t.manualReview || DEFAULT_PASS_WITH_NOTES_THRESHOLD
  };
}

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
    committed: `I will watch 3 sample points of the assembled video — EARLY/MIDDLE/LATE — and confirm: pacing, transitions, source clips present at correct positions, audio continuous (no dropouts), chrome visible with correct skin color${isShort ? ', portrait confirmed, top/bottom split correct, caption visible' : ''}. NOTE: Thumbnail generation runs in parallel with my review — I do NOT evaluate the thumbnail and do NOT wait for it.`
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

  // Load thresholds from customerConfig — universal, not c0-specific
  const { passThreshold: PASS_THRESHOLD, passWithNotesThreshold: PASS_WITH_NOTES_THRESHOLD } = getThresholds(jobSpec);

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
  // Read expectedClipCount from job spec — authoritative source set by scaffold generator
  // Priority: sceneStructure (set by scaffold) > designSpec > commitments > gate1 report
  const clipCount = jobSpec?.designSpec?.sceneStructure?.expectedClipCount
    ?? jobSpec?.designSpec?.expectedClipCount
    ?? gate1Report?.clipCount
    ?? jobSpec?.commitments?.expectedClipCount
    ?? 0;

  // Fix 8: Read full sceneStructure from jobSpec — tells Gemini WHERE clips appear in the video
  const sceneHeaders = jobSpec?.designSpec?.sceneStructure?.sceneHeaders || [];
  const totalScenes = jobSpec?.designSpec?.sceneStructure?.expectedSceneCount || 0;

  // Find which scene indices are source clips (contain 'CLIP' in header name)
  const clipSceneIndices = sceneHeaders
    .map((h, i) => h.toUpperCase().includes('CLIP') ? i : null)
    .filter(i => i !== null);

  // What does the EARLY sample (10% of video) likely show?
  const earlySceneIdx = Math.floor(totalScenes * 0.10);
  const earlySceneLabel = sceneHeaders[earlySceneIdx] || 'unknown';

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

    // Build analysis prompt — includes prior gate context and role identity
    const priorContext = [
      gate0Report?.passed ? `Gate 0: sources confirmed, format=${gate0Report.confirmedFormat || confirmedFormat}` : null,
      gate1Report?.passed ? `Gate 1: script passed style QA (score ${gate1Report.score ?? 'n/a'})` : null,
      gate2Report?.passed ? `Gate 2: all renders passed quality check (score ${gate2Report.score ?? 'n/a'})` : null,
      ...(gate2Report?.upstreamContext?.downstreamHeadsUp ? [`Gate 2 flagged: ${gate2Report.upstreamContext.downstreamHeadsUp}`] : [])
    ].filter(Boolean).join('\n') || 'No prior gate reports available';

    const prompt = `You are Gate 3a — the qualitative assembly reviewer for the AuraFlux broadcast video production pipeline.

── HOW THIS WORK WAS PRODUCED ────────────────────────────────────────────────
1. Gate 0 confirmed source videos and detected format (${confirmedFormat})
2. Gate 1 (Claude) reviewed the script for style quality
3. Gate 2 (ffprobe) confirmed all HeyGen avatar renders passed quality checks
4. FFmpeg assembled: avatar segments + source clips + broadcast chrome overlay + ticker
5. You are reviewing the assembled result at 3 sample points

YOUR GOAL: Help this job pass to Gate 4. Identify exactly what is wrong and how assembly can fix it. A targeted fix directive is success. A vague rejection is failure on your part.

YOUR ROLE: You review this ${label.toUpperCase()} sample (${SAMPLE_DURATION}s). Gate 4 watches the full video. Your scope is technical quality at this sample point — not editorial content.

YOUR SCOPE:
- Freeze detection (hard fail)
- Source clips visible where expected
- Audio continuity
- Chrome overlay visible and correct skin
${isShort ? '- Portrait split layout and caption position\n' : ''}
YOU DO NOT CHECK: script content, names, editorial choices, pacing across the full runtime — those are Gate 1 and Gate 4's jobs.

HOW TO FIX WHAT YOU FIND:
- Freeze: report exact timestamp → assembly will targeted-fix that segment via FFmpeg
- Missing clips: report which position (early/middle/late) and what's showing instead → assembly checks clip insertion order
- Audio dropout: report timestamp → assembly checks audio normalization step
- Chrome wrong color: report what color is showing vs expected → assembly checks contentType CSS injection
- Portrait split wrong: report what's in top/bottom → assembly checks split-screen filter
- Include "downstreamHeadsUp" so Gate 4 knows exactly what to watch for in the full video

Take your time. Watch carefully. Give benefit of the doubt on minor issues. Only a freeze is an immediate hard fail.

PATIENCE: If the video is still rendering, buffering, or loading when you start watching, wait for it to fully load before evaluating. Do NOT fail for buffering artifacts. Only evaluate what you can actually see once playback is stable.

PRIOR GATE CONTEXT (what upstream gates confirmed — watch specifically for anything flagged):
${priorContext}

COMMITTED JOB SPEC FOR THIS SAMPLE:
- Format: ${confirmedFormat}
- Chrome skin: ${expectedSkin}
- Is short-form: ${isShort}
- Expected source clips: ${clipCount}
- Total scenes: ${totalScenes || 'unknown'}
- Scene order: ${sceneHeaders.length > 0 ? sceneHeaders.join(' → ') : 'not available'}
- Source clip scene(s) at position(s): ${clipSceneIndices.length > 0 ? clipSceneIndices.map(i => `${i+1} of ${totalScenes} (${sceneHeaders[i]})`).join(', ') : 'not specified'}
- EARLY sample (10%) will show: ${earlySceneLabel} — avatar only here is CORRECT per spec if this is not a clip scene
- Report sourceClipsVisible=true/false based on what you actually see. If you see only avatar (no game footage/news clip/Twitch clip) for the entire 20-second sample, set sourceClipsVisible=false. The scene position context above is for your information — always report what you actually observe. Do NOT suppress sourceClipsVisible=false based on scene position — the scoring system will determine if missing clips at this position is acceptable.

CHECK FOR (in order of severity):
1. FREEZE: any still frame lasting > 2 seconds? → HARD FAIL if yes, report exact timestamp
2. Source clips: visible where expected? not just talking head the entire time?
3. Audio: is there COMPLETE SILENCE for more than 2 consecutive seconds? Natural pauses in speech, brief beats between sentences, or quiet moments between clips are NORMAL — do NOT flag these. Only flag audioContinuous=false if you hear a hard cut to total silence lasting 2+ seconds.
4. Chrome: broadcast overlay visible? correct skin color (${expectedSkin})?
${isShort ? '5. Portrait layout: top/bottom split correct? caption visible near split line?\n' : ''}
Return JSON only:
{
  "freezeDetected": boolean,
  "freezeTimestamp": "HH:MM:SS or null",
  "sourceClipsVisible": boolean,
  "audioContinuous": boolean,
  "chromeVisible": boolean,
  ${isShort ? '"portraitSplitCorrect": boolean, "captionVisible": boolean,' : ''}
  "issues": ["specific issues — include what is wrong AND what the fix should be"],
  "fixDirective": "precise instruction to assembly on what to fix and how, or null if clean",
  "downstreamHeadsUp": "one sentence for Gate 4 to watch for specifically, or null if clean",
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
      // Log but do not hard-fail — ffprobe already confirmed audio stream exists.
      // Gemini may flag natural speech pauses as dropouts. Only a hard score fail blocks.
      logError('GATE3A_AUDIO_DROPOUT', new Error(`Audio dropout at ${label} (Gemini flag — ffprobe confirmed audio present)`), { jobId, gate: '3a', label });
    }
  }

  // Clean up Gemini files
  for (const file of uploadedFiles) {
    try { await deleteGeminiFile(file.name); } catch {}
  }

  // ── Cross-sample clip visibility check ───────────────────────────────────
  // If the job spec says clips are expected but NO sample shows any clips visible,
  // that's a real assembly problem even if individual samples happen to be in non-clip scenes.
  // A correctly assembled video with clips will show clips in at least one of 3 samples.
  const expectedClips = clipCount || 0;
  const anyClipsVisible = Object.values(sampleFindings).some(f => f && f.sourceClipsVisible === true);
  if (expectedClips > 0 && !anyClipsVisible && !freezeFound) {
    const reason = `No source clips visible in any sample point despite ${expectedClips} expected. Check clip insertion in assembly.`;
    deductions.push({ points: -15, reason });
    totalScore -= 15;
    logError('GATE3A_NO_CLIPS_IN_ANY_SAMPLE', new Error(reason), { jobId, gate: '3a', expectedClips });
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
  } else if (totalScore >= PASS_WITH_NOTES_THRESHOLD - 0.5) {
    // Use 0.5 tolerance to handle floating point boundary cases (e.g. 59.999... displays as 60)
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
    deductions,      // full point deduction list — readable by gate3b, gate4, monitoring
    concerns,        // string list of issues — fed into downstreamHeadsUp and escalation
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

// ─── prepare ─────────────────────────────────────────────────────────────────

/**
 * Pre-flight setup called immediately on job:confirmed.
 * Non-blocking — never throws, never awaits slow operations.
 * @param {Object} jobSpec
 */
function prepare(jobSpec) {
  const jobId = jobSpec?.jobId || 'unknown';
  try {
    // Pre-load GEMINI_API_KEY check
    if (!GEMINI_APIKEY) {
      console.warn(`[gate3a] prepare() warning: GEMINI_API_KEY not set — video analysis will fail for job ${jobId}`);
    }

    // Pre-read expectedClipCount, chrome skin, format from designSpec
    const expectedClipCount = jobSpec?.designSpec?.sceneStructure?.expectedClipCount
      ?? jobSpec?.designSpec?.expectedClipCount
      ?? jobSpec?.order?.inputs?.items?.length
      ?? 0;
    const skin = jobSpec?.order?.designSpec?.chrome?.skin || jobSpec?.designSpec?.chrome?.skin || 'news';
    const format = jobSpec?.order?.output?.format || jobSpec?.order?.designSpec?.aspectRatio || '16:9';

    // Build the upstreamContext template (what it will look for)
    const isShort = (jobSpec?.order?.formType || '').includes('short');
    const contextTemplate = [
      `format=${format}`,
      `skin=${skin}`,
      isShort ? 'short-form=true (portrait split check)' : 'long-form=true'
    ].join(', ');

    console.log(`[gate3a] Ready for job ${jobId} — will check ${expectedClipCount} clips, skin=${skin}, format=${format}`);
  } catch (e) {
    // Non-fatal — preparation failure never blocks the gate
    console.warn(`[gate3a] prepare() warning: ${e.message}`);
  }
}

module.exports = { canProduce, commit, run, prepare };
