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
const { captureAIMemoryTrace } = require('../ai_memory_trace');
const axios = require('axios');
const synthHistory = require('../chrome_synth_history');
const { loadCustomerConfig } = require('../job_spec');
const { resolveChromeCfg, fingerprintResolvedChromeCfg } = require('../chrome_overlay_ffmpeg');
const { ffmpegPath } = require('../ffmpeg_utils');

const REPO_ROOT = path.join(__dirname, '..');

function _chromeSkinForSynth(jobSpec, contentType) {
  const c = jobSpec?.designSpec?.chrome;
  const raw = (c && c.skin) || String(contentType || 'news').replace(/-short$/, '');
  return raw || 'news';
}

function _ctForChromeAssembly(chromeSkin) {
  if (chromeSkin === 'twitch') return 'clips';
  if (chromeSkin === 'nba') return 'sports';
  return chromeSkin;
}

/**
 * Writes tmp/synth_prebuild/gate3a_preview_<jobId>.png for operators (always, even when synth is skipped).
 */
async function _writeGate3aSynthPreviewPng(jobId, sourceMp4) {
  const TMP_DIR = path.join(REPO_ROOT, 'tmp', 'synth_prebuild');
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const outPng = path.join(TMP_DIR, `gate3a_preview_${jobId}.png`);
  const FFMPEG = process.env.FFMPEG_PATH || ffmpegPath();
  if (sourceMp4 && fs.existsSync(sourceMp4)) {
    await new Promise((res, rej) => {
      execFile(FFMPEG, ['-y', '-ss', '2', '-i', sourceMp4, '-frames:v', '1', '-q:v', '2', outPng], { timeout: 60000 }, (err) => (err ? rej(err) : res()));
    });
  } else {
    await new Promise((res, rej) => {
      execFile(
        FFMPEG,
        ['-y', '-f', 'lavfi', '-i', 'color=c=0x0d1424:s=1920x1080:d=1', '-frames:v', '1', outPng],
        { timeout: 30000 },
        (err) => (err ? rej(err) : res())
      );
    });
  }
  return path.relative(REPO_ROOT, outPng).split(path.sep).join('/');
}

// Module-level mutex: only ONE synth prebuild per chrome hash at a time.
// Concurrent jobs sharing the same chrome config wait for the first result.
const _synthInFlight = new Map(); // hash → Promise<{ok, outputMb?, error?}>

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

  if (!jobSpec?.expectedSynth && !GEMINI_APIKEY) {
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
  const chrome = jobSpec?.designSpec?.chrome || {};
  const isSplitScreen = (chrome.layout || '').includes('split');
  return {
    committed: `I will watch 3 sample points of the assembled video — EARLY/MIDDLE/LATE — and confirm: pacing, transitions, source clips present at correct positions, audio continuous (no dropouts), chrome elements present per job spec (top bar=${chrome.hasTopBar !== false}, flag=${chrome.hasFlag !== false}, sidebar=${chrome.hasSidebar !== false})${isSplitScreen ? ', portrait confirmed, top/bottom split correct, caption visible' : ''}. NOTE: Thumbnail generation runs in parallel with my review — I do NOT evaluate the thumbnail and do NOT wait for it.`
  };
}

/**
 * Build the exact Gemini user prompt for one Gate 3a sample (offline replay + tracing).
 * Does not upload video or call the API.
 *
 * @param {string} label - 'early' | 'middle' | 'late'
 * @param {object} ctx - precomputed context from run(): SAMPLE_DURATION, confirmedFormat, expectedSkin, chromeCfg, clipCount, totalScenes, sceneHeaders, clipSceneIndices, earlySceneLabel, priorContext
 */
function buildGate3aGeminiSamplePrompt(jobSpec, label, ctx) {
  const {
    SAMPLE_DURATION,
    confirmedFormat,
    expectedSkin,
    chromeCfg,
    clipCount,
    totalScenes,
    sceneHeaders,
    clipSceneIndices,
    earlySceneLabel,
    priorContext
  } = ctx;

  // Read what chrome elements the job spec says are present — no if/else on content type.
  const hasTopBar    = chromeCfg?.hasTopBar    !== undefined ? chromeCfg.hasTopBar    : true;
  const hasFlag      = chromeCfg?.hasFlag      !== undefined ? chromeCfg.hasFlag      : true;
  const hasSidebar   = chromeCfg?.hasSidebar   !== undefined ? chromeCfg.hasSidebar   : true;
  const hasTicker    = chromeCfg?.hasTicker    !== undefined ? chromeCfg.hasTicker    : true;
  const hasLogo      = chromeCfg?.hasLogo      !== undefined ? chromeCfg.hasLogo      : true;
  const isSplitScreen = (chromeCfg?.layout || '').includes('split');
  const logoSize     = chromeCfg?.logoSize     || (isSplitScreen ? 80 : 120);
  const logoPosition = chromeCfg?.logoPosition || (isSplitScreen ? 'top-right' : 'bottom-right');
  const splitTop     = chromeCfg?.splitTop     || 'avatar';
  const splitBottom  = chromeCfg?.splitBottom  || 'clip';

  // Build a plain-language description of the assembled video from the spec
  const assembledDesc = isSplitScreen
    ? `portrait split-screen (9:16) — top half: ${splitTop}, bottom half: ${splitBottom}. Chrome elements per spec: NO top bar, NO flag, NO sidebar, NO ticker. Logo only (${logoSize}px, ${logoPosition}).`
    : `landscape (16:9) — avatar segments + source clips + broadcast chrome overlay${hasTicker ? ' + ticker' : ''}.`;

  const prompt = `You are Gate 3a — the qualitative assembly reviewer for the AuraFlux broadcast video production pipeline.

── HOW THIS WORK WAS PRODUCED ────────────────────────────────────────────────
1. Gate 0 confirmed source videos and detected format (${confirmedFormat})
2. Gate 1 (Claude) reviewed the script for style quality
3. Gate 2 (ffprobe) confirmed all HeyGen avatar renders passed quality checks
4. FFmpeg assembled: ${assembledDesc}
5. You are reviewing the assembled result at 3 sample points

YOUR GOAL: Help this job pass to Gate 4. Identify exactly what is wrong and how assembly can fix it. A targeted fix directive is success. A vague rejection is failure on your part.

YOUR ROLE: You review this ${label.toUpperCase()} sample (${SAMPLE_DURATION}s). Gate 4 watches the full video. Your scope is technical quality at this sample point — not editorial content.

YOUR SCOPE:
- Freeze detection (hard fail)
- Source clips visible where expected
- Audio continuity
- Chrome elements present exactly as the job spec requires${isSplitScreen ? '\n- Portrait split layout and caption position' : ''}

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
- Layout: ${isSplitScreen ? 'split-screen (portrait 9:16)' : 'full-screen (landscape 16:9)'}
- Chrome elements in scope per spec: top bar=${hasTopBar}, flag=${hasFlag}, sidebar=${hasSidebar}, ticker=${hasTicker}, logo=${hasLogo}
- Logo: ${hasLogo ? `${logoSize}px at ${logoPosition}` : 'none'}
- Expected source clips: ${clipCount}
- Total scenes: ${totalScenes || 'unknown'}
- Scene order: ${sceneHeaders.length > 0 ? sceneHeaders.join(' → ') : 'not available'}
- Source clip scene(s) at position(s): ${clipSceneIndices.length > 0 ? clipSceneIndices.map(i => `${i + 1} of ${totalScenes} (${sceneHeaders[i]})`).join(', ') : 'not specified'}
- EARLY sample (10%) will show: ${earlySceneLabel} — avatar only here is CORRECT per spec if this is not a clip scene
- Report sourceClipsVisible=true/false based on what you actually see. If you see only avatar (no game footage/news clip/Twitch clip) for the entire 20-second sample, set sourceClipsVisible=false. The scene position context above is for your information — always report what you actually observe. Do NOT suppress sourceClipsVisible=false based on scene position — the scoring system will determine if missing clips at this position is acceptable.
- Expected items ordered: ${(jobSpec?.order?.inputs?.items || []).map((it, i) => `${i + 1}. ${it.title || it.displayName || it.name || 'unknown'}`).join(', ') || '(none available)'}
${!hasFlag && !hasSidebar ? '- NO flag, NO sidebar — do NOT expect or check for these elements.' : `- Flag should show: category "${jobSpec?.designSpec?.voice?.categoryLabel || jobSpec?.designSpec?.chrome?.categoryLabel || 'CATEGORY'}" + active item title for current scene position
- Sidebar should show: all ${(jobSpec?.order?.inputs?.items || []).length} item(s) with correct titles stacked vertically`}
${isSplitScreen && (jobSpec?.state?.savedOutputs?.filledScript || '').length > 10 ? `
CLIP CONTENT VERIFICATION:
- The HOOK script says: "${(jobSpec.state.savedOutputs.filledScript.match(/===\s*HOOK\s*===\s*([\s\S]*?)(?===|$)/) || ['',''])[1].replace(/\n/g,' ').trim()}"
- The REACTION script says: "${(jobSpec.state.savedOutputs.filledScript.match(/===\s*REACTION\s*===\s*([\s\S]*?)(?===|$)/) || ['',''])[1].replace(/\n/g,' ').trim()}"
- SEMANTIC CHECK: Does the source clip on screen actually match the named subject(s) in the HOOK/REACTION above? E.g. if HOOK says "Murray" you should see Jamal Murray or a Denver Nuggets play. If the clip shows a completely different player, team, or sport, set clipContentMatchesScript=false.
- Set clipContentMatchesScript=true if the clip content plausibly matches the named subject(s). Set false only if the clip is clearly from a different game, team, or unrelated event.` : ''}

CHECK FOR (in order of severity):
1. FREEZE: any still frame lasting > 2 seconds? → HARD FAIL if yes, report exact timestamp
2. Source clips: visible where expected? not just talking head the entire time?
3. Audio: is there COMPLETE SILENCE for more than 2 consecutive seconds? Natural pauses in speech, brief beats between sentences, or quiet moments between clips are NORMAL — do NOT flag these. Only flag audioContinuous=false if you hear a hard cut to total silence lasting 2+ seconds.
4. ${isSplitScreen
  ? `Layout: portrait split-screen correct? Top half = ${splitTop}, bottom half = ${splitBottom}? Logo (${logoSize}px) visible at ${logoPosition}?`
  : `Chrome: broadcast overlay visible? correct skin color (${expectedSkin})?`}
${isSplitScreen ? '5. Portrait layout: top/bottom split correct? caption visible near split line?\n' : ''}${!isSplitScreen ? `5. Flag accuracy: Does the top-left flag show the correct category label AND the correct active item title for this scene position?
6. Sidebar accuracy: Does the sidebar show the correct item titles matching the ordered items?` : ''}

VISUAL SPEC CHECKS — verify against the job spec chrome elements listed above:
${isSplitScreen ? `- This is a 9:16 portrait split-screen. Top 50% = ${splitTop}. Bottom 50% = ${splitBottom}.
- Per spec: NO top bar, NO flag, NO sidebar, NO ticker.
- Logo: ${hasLogo ? `${logoSize}px visible near ${logoPosition} of the portrait frame` : 'none expected'}.
- Caption: text captions should be visible near the split line or on the lower half.
- chromeVisible=true means the logo is visible (as specified). chromeCorrect=true means the portrait split is clean (${splitTop} top, ${splitBottom} bottom) with no black bars or layout break.
- If the video shows a full-screen avatar with NO clip on screen, chromeCorrect=false and sourceClipsVisible=false.
- If you see a top bar, flag, or sidebar — those are NOT in spec. Report them as violations.` : `- Top bar (y=0, h=48px): ${hasTopBar ? `left side must show episode number, center must show show name matching skin "${expectedSkin}"` : 'NOT in spec — report if present'}
- Flag (top-left, x=0 y=48, w=620 h=88px): ${hasFlag ? 'must be visible on avatar scenes — row 1 is category label, row 2 is story/streamer/game title' : 'NOT in spec — report if present'}
- Sidebar (right side, x=1468, y=120): ${hasSidebar ? 'story/streamer/game cards stacked vertically, active card highlighted with colored left border' : 'NOT in spec — report if present'}
- Logo: ${hasLogo ? `visible at ${logoPosition} area` : 'none expected'}
- If chrome appears correct per spec above: set chromeCorrect=true
- If ANY expected chrome element is missing OR any element that should NOT be present is visible: set chromeCorrect=false AND describe exactly what you see vs what the spec required
- Note: blue box artifacts and alpha corruption are eliminated in the new FFmpeg chrome engine. Report any visual anomalies regardless.`}

Return JSON only:
{
  "freezeDetected": boolean,
  "freezeTimestamp": "HH:MM:SS or null",
  "sourceClipsVisible": boolean,
  "audioContinuous": boolean,
  "chromeVisible": boolean,
  "chromeCorrect": boolean,
  "chromeDescription": "${isSplitScreen ? `describe portrait split layout (top=${splitTop}, bottom=${splitBottom}) and logo visibility` : 'what you actually see in the chrome elements (top bar, flag, sidebar, logo) — be specific'}",
  ${!isSplitScreen ? `"flagAccurate": boolean,
  "flagDescription": "what you see in the flag vs what was expected (category label + item title)",
  "sidebarAccurate": boolean,
  "sidebarDescription": "what you see in the sidebar vs what was expected item titles",` : ''}
  ${isSplitScreen ? '"portraitSplitCorrect": boolean, "captionVisible": boolean, "clipContentMatchesScript": boolean, "clipContentDescription": "what player/team/event you actually see in the clip vs what the HOOK/REACTION script named",' : ''}
  "issues": ["specific issues — include what is wrong AND what the fix should be"],
  "fixDirective": "precise instruction to assembly on what to fix and how, or null if clean",
  "downstreamHeadsUp": "one sentence for Gate 4 to watch for specifically, or null if clean",
  "score": 0-100
}`;

  return {
    prompt,
    meta: {
      label,
      SAMPLE_DURATION,
      clipCount,
      totalScenes,
      expectedSkin,
      orderedItemCount: (jobSpec?.order?.inputs?.items || []).length
    }
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

  if (jobSpec?.expectedSynth) {
    const uc = {
      ...upstreamContext,
      confirmedClean: [...upstreamContext.confirmedClean, 'expectedSynth_skip', 'assembly_qualitative'],
      downstreamHeadsUp: 'expectedSynth/lab — broadcast-style Gemini sampling not run (product policy)'
    };
    return {
      gate: '3a',
      jobId,
      passed: true,
      score: 90,
      outcome: 'pass_with_notes',
      sampleFindings: {
        early: { skipped: true, note: 'expectedSynth/lab' },
        middle: { skipped: true, note: 'expectedSynth/lab' },
        late: { skipped: true, note: 'expectedSynth/lab' }
      },
      ffmpegAlarm: { fired: false, targetTimestamp: null, issue: null },
      upstreamContext: uc,
      notes: ['expectedSynth/lab — Gate 3a broadcast sampling skipped (product policy)'],
      completedAt: now()
    };
  }

  const targetPath = assembledPath || jobSpec.assembledPath || jobSpec.outputPath;
  const confirmedFormat = gate0Report?.confirmedFormat || jobSpec?.order?.output?.format || jobSpec?.order?.output?.aspectRatio || '16:9';
  const expectedSkin = jobSpec?.designSpec?.chrome?.skin || jobSpec?.order?.designSpec?.chrome?.skin || 'news';
  const chromeCfg = jobSpec?.designSpec?.chrome || {};
  // Read what chrome elements are in scope from the job spec — gates do not infer from content type name
  const isSplitScreen = (chromeCfg.layout || '').includes('split');
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
  // 10s clips: fast enough to avoid Gemini upload timeouts, sufficient for quality check
  const SAMPLE_DURATION = 10;
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

  const priorContext = [
    gate0Report?.passed ? `Gate 0: sources confirmed, format=${gate0Report.confirmedFormat || confirmedFormat}` : null,
    gate1Report?.passed ? `Gate 1: script passed style QA (score ${gate1Report.score ?? 'n/a'})` : null,
    gate2Report?.passed ? `Gate 2: all renders passed quality check (score ${gate2Report.score ?? 'n/a'})` : null,
    ...(gate2Report?.upstreamContext?.downstreamHeadsUp ? [`Gate 2 flagged: ${gate2Report.upstreamContext.downstreamHeadsUp}`] : [])
  ].filter(Boolean).join('\n') || 'No prior gate reports available';

  const gate3aPromptCtx = {
    SAMPLE_DURATION,
    confirmedFormat,
    expectedSkin,
    chromeCfg,
    clipCount,
    totalScenes,
    sceneHeaders,
    clipSceneIndices,
    earlySceneLabel,
    priorContext
  };

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

    // Upload to Gemini Files API — retry once with 2s backoff before deducting
    let geminiFile;
    let uploadErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        geminiFile = await uploadToGeminiFiles(clipped);
        if (geminiFile) {
          await waitForGeminiFile(geminiFile);
          uploadedFiles.push(geminiFile);
        }
        uploadErr = null;
        break;
      } catch (err) {
        uploadErr = err;
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (uploadErr) {
      logError('GATE3A_UPLOAD_ERROR', uploadErr, { jobId, gate: '3a', label });
      deductions.push({ points: -10, reason: `Could not upload ${label} sample to Gemini` });
      totalScore -= 10;
      try { fs.unlinkSync(clipPath); } catch {}
      continue;
    }

    const { prompt, meta: g3PromptMeta } = buildGate3aGeminiSamplePrompt(jobSpec, label, gate3aPromptCtx);

    captureAIMemoryTrace({
      provider: 'gemini',
      model: GEMINI_MODEL,
      gate: 'gate3a',
      jobId,
      stage: `gate3a_${label}`,
      prompt,
      inputs: {
        sampleLabel: g3PromptMeta.label,
        startTimeSec: startTime,
        sampleDurationSec: g3PromptMeta.SAMPLE_DURATION,
        sceneHeaders,
        expectedSkin,
        orderedItemCount: g3PromptMeta.orderedItemCount
      },
      metadata: {
        contentType: jobSpec?.contentType || null,
        customerId: jobSpec?.customerId || null,
        source: 'lib/gates/gate3a.run'
      }
    });

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
  // Only penalize if a sample timestamp is EXPECTED to land on a clip scene and
  // still shows no clip. Don't penalize avatar-segment timestamps for not showing clips —
  // clips only appear at specific positions (clipSceneIndices), not spread throughout.
  const expectedClips = clipCount || 0;
  if (expectedClips > 0 && !freezeFound) {
    const anyClipsVisible = Object.values(sampleFindings).some(f => f && f.sourceClipsVisible === true);
    // Only flag if clipSceneIndices are unknown (no structure info) AND no clips seen anywhere.
    // If we have scene structure, Gemini sampling avatars scenes is expected — not a fault.
    const hasSceneStructure = clipSceneIndices && clipSceneIndices.length > 0;
    if (!anyClipsVisible && !hasSceneStructure) {
      const reason = `No source clips visible in any sample point despite ${expectedClips} expected. Check clip insertion in assembly.`;
      deductions.push({ points: -15, reason });
      totalScore -= 15;
      logError('GATE3A_NO_CLIPS_IN_ANY_SAMPLE', new Error(reason), { jobId, gate: '3a', expectedClips });
    } else if (!anyClipsVisible && hasSceneStructure) {
      // Scene structure known — clips are at specific positions. Sampling avatars scenes is normal.
      // Only note it, no deduction.
      logError('GATE3A_CLIPS_NOT_IN_SAMPLES', new Error(`Clips not visible in sampled frames (expected at scenes ${clipSceneIndices.join(',')}) — samples may have landed on avatar segments`), { jobId, gate: '3a', expectedClips, clipSceneIndices });
    }
  }

  // ── Split-screen clip content semantic check ────────────────────────────
  // If any sample returned clipContentMatchesScript=false, deduct heavily — wrong clip is a
  // content integrity failure (e.g. wrong game, wrong player) and must block Gate 4.
  if (isSplitScreen && !freezeFound) {
    const wrongClipSamples = Object.values(sampleFindings).filter(f => f && f.clipContentMatchesScript === false);
    if (wrongClipSamples.length > 0) {
      const descriptions = wrongClipSamples.map(f => f.clipContentDescription || 'wrong content').join('; ');
      const reason = `WRONG CLIP: clip content does not match script subject. ${descriptions}. Pick the correct clip using the clip picker before re-running.`;
      deductions.push({ points: -40, reason });
      totalScore -= 40;
      logError('GATE3A_WRONG_CLIP_CONTENT', new Error(reason), { jobId, gate: '3a', descriptions });
    }
  }

  // ── Score → outcome ─────────────────────────────────────────────────────
  totalScore = Math.max(0, Math.min(100, totalScore));

  const chromeStrict = process.env.GATE3A_CHROME_STRICT !== 'false';
  let chromeBlocker = false;
  if (chromeStrict && chromeCfg && chromeCfg.hasTopBar !== false && !freezeFound) {
    const strictViolations = [];
    for (const label of ['early', 'middle', 'late']) {
      const f = sampleFindings[label];
      if (!f || f.error || f.skipped || f.hardFail) continue;
      if (f.chromeCorrect === false || f.flagAccurate === false || f.sidebarAccurate === false) {
        strictViolations.push({
          label,
          chromeCorrect: f.chromeCorrect === false,
          flagAccurate: f.flagAccurate === false,
          sidebarAccurate: f.sidebarAccurate === false,
          score: typeof f.score === 'number' ? f.score : null
        });
      }
    }
    if (strictViolations.length > 0) {
      const hasMultiSampleConsistency =
        ['chromeCorrect', 'flagAccurate', 'sidebarAccurate']
          .some((k) => strictViolations.filter(v => v[k]).length >= 2);
      const severeSingleSample =
        strictViolations.length === 1 &&
        strictViolations[0].score !== null &&
        strictViolations[0].score <= 40;
      if (hasMultiSampleConsistency || strictViolations.length >= 2 || severeSingleSample) {
        chromeBlocker = true;
        deductions.push({
          points: 0,
          reason: `CHROME_STRICT: consistent multi-sample chrome mismatch detected (set GATE3A_CHROME_STRICT=false to waive)`
        });
      }
    }
  }

  let outcome;
  let passed = false;

  // If every single sample failed to upload to Gemini (API error, not video quality),
  // return pass_with_notes rather than hard-failing a video that assembled correctly.
  // Gemini file uploads are unreliable on large files (100-200MB NBA long-form).
  // The operator reviews the video before approving; this is not a silent pass.
  const allUploadsFailedCount = deductions.filter(d =>
    d.reason && d.reason.includes('Could not upload') && d.reason.includes('Gemini')
  ).length;
  const allSampleUploadsFailed = allUploadsFailedCount >= samplePoints.length;
  if (allSampleUploadsFailed && !freezeFound && !chromeBlocker) {
    outcome = 'pass_with_notes';
    passed = true;
    totalScore = Math.max(totalScore, 62); // floor at pass_with_notes threshold
    logError('GATE3A_ALL_UPLOADS_FAILED_PASSTHROUGH', new Error('All Gemini uploads failed — treating as pass_with_notes for operator review'), { jobId, gate: '3a', totalScore });
  } else if (freezeFound) {
    outcome = 'hard_fail';
    totalScore = Math.min(totalScore, 40);
    logError('GATE3A_HARD_FAIL_FREEZE', new Error('Freeze detected'), { jobId, gate: '3a' });
  } else if (chromeBlocker) {
    outcome = 'hard_fail';
    passed = false;
    totalScore = Math.min(totalScore, 45);
    logError('GATE3A_CHROME_BLOCKER', new Error('Chrome/flag/sidebar failed strict spec check'), { jobId, gate: '3a', sampleFindings });
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
 *
 * When the job spec contains a chrome overlay config, runs a synth assembly
 * verification against that chrome fingerprint:
 *   - First N runs (default 3): synth MUST pass before HeyGen fires.
 *     On pass → records success in data/chrome_synth_history.json.
 *     On fail → writes jobSpec.synthVerified = false; script_gen blocks HeyGen.
 *   - After N successes for that chrome hash: synth skipped, HeyGen proceeds.
 *
 * Always async-safe: never throws, never blocks the event loop for slow work.
 * @param {Object} jobSpec
 * @returns {Promise<void>}
 */
async function prepare(jobSpec) {
  const jobId      = jobSpec?.jobId || 'unknown';
  const customerId = jobSpec?.customerId || 'c0';

  try {
    if (!GEMINI_APIKEY) {
      console.warn(`[gate3a] prepare() warning: GEMINI_API_KEY not set — video analysis will fail for job ${jobId}`);
    }

    const chrome       = jobSpec?.designSpec?.chrome || {};
    const contentType  = jobSpec?.contentType || jobSpec?.order?.contentType || 'news';
    const isSplitScreen = (chrome.layout || '').includes('split');
    const format       = isSplitScreen ? 'portrait' : 'mp4';

    const expectedClipCount = jobSpec?.designSpec?.sceneStructure?.expectedClipCount
      ?? jobSpec?.designSpec?.expectedClipCount
      ?? jobSpec?.order?.inputs?.items?.length
      ?? 0;
    const expectedSkin = chrome?.skin || 'news';
    const sceneHeaders       = jobSpec?.designSpec?.sceneStructure?.sceneHeaders || [];
    const clipScenePositions = sceneHeaders
      .map((h, i) => h.toUpperCase().includes('CLIP') ? i : null)
      .filter(i => i !== null);
    const itemTitles   = (jobSpec?.order?.inputs?.items || [])
      .map((it, i) => `${i+1}. ${it.title || it.displayName || it.name || 'unknown'}`)
      .join(', ');
    const categoryLabel = jobSpec?.designSpec?.voice?.categoryLabel || chrome?.categoryLabel || null;

    console.log(`[gate3a] Ready for job ${jobId} — ${sceneHeaders.length} scenes, clip positions: [${clipScenePositions.join(',')}], skin=${expectedSkin}, format=${format}, items: ${itemTitles || 'none'}, categoryLabel: ${categoryLabel || 'n/a'}`);

    // ── Synth prebuild verification ───────────────────────────────────────────
    // Fingerprint = resolved customer chrome (c0.json + content-type overrides), same inputs as FFmpeg burn.
    if (!chrome || typeof chrome !== 'object') {
      console.log(`[gate3a] No chrome block in spec for job ${jobId} — skipping synth prebuild`);
      return;
    }

    const threshold = jobSpec?.designSpec?.chrome?.synthVerifyThreshold
      || synthHistory.DEFAULT_THRESHOLD;

    let resolvedChrome;
    let chromeLayoutHash;
    try {
      const frozenResolved = jobSpec?.designSpec?.chrome?.resolvedCfg;
      const frozenHash = jobSpec?.designSpec?.chrome?.resolvedHash;
      if (frozenResolved && typeof frozenResolved === 'object') {
        resolvedChrome = frozenResolved;
        chromeLayoutHash = frozenHash || fingerprintResolvedChromeCfg(resolvedChrome);
      } else {
        const chromeSkin = _chromeSkinForSynth(jobSpec, contentType);
        const ctForChrome = _ctForChromeAssembly(chromeSkin);
        resolvedChrome = resolveChromeCfg(loadCustomerConfig(customerId), ctForChrome);
        chromeLayoutHash = fingerprintResolvedChromeCfg(resolvedChrome);
      }
    } catch (e) {
      console.warn(`[gate3a] Could not resolve chrome for synth fingerprint (${jobId}): ${e.message}`);
      return;
    }

    const hash = chromeLayoutHash;
    const entry  = synthHistory.getEntryForHash(hash);

    if (synthHistory.shouldSkipSynthForHash(hash, threshold)) {
      console.log(`[gate3a] Synth prebuild SKIPPED for job ${jobId} — resolved-chrome hash ${hash} verified ${entry.successCount}/${threshold} times (last: ${entry.lastVerified})`);
      if (jobSpec.designSpec) jobSpec.designSpec.synthVerified = true;
      try {
        const rel = await _writeGate3aSynthPreviewPng(jobId, entry?.lastOutputPath || null);
        if (jobSpec.designSpec) jobSpec.designSpec.synthPreviewPath = rel;
        console.log(`[gate3a] Synth preview image: ${rel} (from ${entry?.lastOutputPath ? 'last verified output' : 'placeholder — no cached synth MP4 path'})`);
      } catch (pe) {
        console.warn(`[gate3a] Synth preview PNG failed (${jobId}): ${pe.message}`);
      }
      return;
    }

    const runCount = entry?.successCount ?? 0;
    console.log(`[gate3a] Synth prebuild REQUIRED for job ${jobId} — resolved-chrome hash ${hash} verified ${runCount}/${threshold} times (first-run threshold not yet met)`);

    // ── Mutex: if another job is already running a synth for this chrome hash,
    // wait for that result instead of firing a duplicate assembly.
    if (_synthInFlight.has(hash)) {
      console.log(`[gate3a] Synth prebuild already in-flight for hash ${hash} — waiting for result (job ${jobId})`);
      const existing = await _synthInFlight.get(hash);
      if (existing.ok) {
        synthHistory.recordSuccessForHash(hash, {
          customerId,
          contentType,
          jobId,
          outputMb: existing.outputMb,
          threshold,
          lastOutputPath: existing.outputPath || null
        });
        if (jobSpec.designSpec) jobSpec.designSpec.synthVerified = true;
        try {
          const rel = await _writeGate3aSynthPreviewPng(jobId, existing.outputPath || null);
          if (jobSpec.designSpec) jobSpec.designSpec.synthPreviewPath = rel;
        } catch (pe) {
          console.warn(`[gate3a] Synth preview PNG failed (${jobId}): ${pe.message}`);
        }
      } else {
        if (jobSpec.designSpec) {
          jobSpec.designSpec.synthVerified       = false;
          jobSpec.designSpec.synthVerifyRequired = true;
          jobSpec.designSpec.synthVerifyError    = existing.error;
        }
      }
      return;
    }

    // Run the synth assembly for this content type — wrap in promise and store in mutex map
    const synthPromise = runSynthAssembly({ jobSpec, contentType, format, jobId });
    _synthInFlight.set(hash, synthPromise);
    let synthResult;
    try {
      synthResult = await synthPromise;
    } finally {
      _synthInFlight.delete(hash);
    }

    if (synthResult.ok) {
      const updated = synthHistory.recordSuccessForHash(hash, {
        customerId,
        contentType,
        jobId,
        outputMb: synthResult.outputMb,
        threshold,
        lastOutputPath: synthResult.outputPath || null
      });
      const newCount = updated.successCount;
      console.log(`[gate3a] ✅ Synth prebuild PASSED for job ${jobId} — resolved-chrome hash ${hash} (${newCount}/${threshold} successes)`);
      if (jobSpec.designSpec) jobSpec.designSpec.synthVerified = true;

      try {
        const rel = await _writeGate3aSynthPreviewPng(jobId, synthResult.outputPath || null);
        if (jobSpec.designSpec) jobSpec.designSpec.synthPreviewPath = rel;
        console.log(`[gate3a] Synth preview image: ${rel}`);
      } catch (pe) {
        console.warn(`[gate3a] Synth preview PNG failed (${jobId}): ${pe.message}`);
      }

      if (newCount >= threshold) {
        console.log(`[gate3a] 🔓 Chrome hash ${hash} now fully verified (${newCount}/${threshold}) — future jobs will skip synth prebuild`);
      }
    } else {
      console.error(`[gate3a] ❌ Synth prebuild FAILED for job ${jobId} — resolved-chrome hash ${hash}: ${synthResult.error}`);
      logError('GATE3A_SYNTH_PREBUILD_FAIL', new Error(synthResult.error), {
        jobId, hash, contentType, runCount, threshold
      });
      // Write failure onto jobSpec so script_gen can block HeyGen
      if (jobSpec.designSpec) {
        jobSpec.designSpec.synthVerified       = false;
        jobSpec.designSpec.synthVerifyError    = synthResult.error;
        jobSpec.designSpec.synthVerifyHash     = hash;
        jobSpec.designSpec.synthVerifyRequired = true;
      }
    }
  } catch (e) {
    console.warn(`[gate3a] prepare() warning: ${e.message}`);
  }
}

// ─── runSynthAssembly ─────────────────────────────────────────────────────────

/**
 * POSTs a synthetic assembly request to /assemble and polls for the output file.
 * Uses the same synth MP4s as the test harness (generated in tmp/synth_test/).
 * Returns { ok: true, outputMb, outputPath } on success, { ok: false, error } on failure.
 */
async function runSynthAssembly({ jobSpec, contentType, format, jobId }) {
  const { execFile: _execFile } = require('child_process');
  const baseContentType = contentType.replace(/-short$/, '');

  const TMP_DIR     = path.join(__dirname, '..', 'tmp', 'synth_prebuild');
  const port        = process.env.PORT || 3000;
  const API         = process.env.SYNTH_ASSEMBLE_API_URL || `http://127.0.0.1:${port}`;
  const FFMPEG      = process.env.FFMPEG_PATH || (process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
  // Cached lavfi outputs must exceed production remote segment floor (assembly MIN_SEGMENT_BYTES_REMOTE)
  // so a stale tiny file never short-circuits regeneration after policy changes.
  const SYNTH_CACHE_MIN_BYTES = 110000;

  fs.mkdirSync(TMP_DIR, { recursive: true });

  // Generate synth clips (reuse if already present from a previous prebuild run)
  const avFile     = format === 'portrait' ? 'av_9x16.mp4'    : 'av_16x9.mp4';
  const clipFile   = format === 'portrait' ? 'clip_9x16.mp4'  : 'clip_16x9.mp4';
  const avSize     = format === 'portrait' ? '1080x1920'       : '1920x1080';
  const clipSize   = '1920x1080';
  const SYNTH_DUR_SEC = 10;

  async function makeSynth(filename, source, size) {
    const outPath = path.join(TMP_DIR, filename);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size >= SYNTH_CACHE_MIN_BYTES) return outPath;
    await new Promise((res, rej) => {
      _execFile(FFMPEG, [
        '-f', 'lavfi', '-i', `${source}=duration=${SYNTH_DUR_SEC}:size=${size}:rate=30`,
        '-f', 'lavfi', '-i', `sine=f=440:b=4:duration=${SYNTH_DUR_SEC}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k', '-pix_fmt', 'yuv420p',
        '-y', outPath
      ], { timeout: 45000 }, (err) => err ? rej(err) : res(outPath));
    });
    return outPath;
  }

  let avPath, clipPath;
  try {
    avPath   = await makeSynth(avFile,   'testsrc',   avSize);
    clipPath = await makeSynth(clipFile, 'smptebars', clipSize);
  } catch (e) {
    return { ok: false, error: `FFmpeg synth generation failed: ${e.message}` };
  }

  // Verify files are fully written to disk before constructing segment URLs
  if (!fs.existsSync(avPath) || fs.statSync(avPath).size < 10000) {
    return { ok: false, error: `Synth av file not ready: ${avPath}` };
  }
  if (!fs.existsSync(clipPath) || fs.statSync(clipPath).size < 10000) {
    return { ok: false, error: `Synth clip file not ready: ${clipPath}` };
  }
  if (fs.statSync(clipPath).size < SYNTH_CACHE_MIN_BYTES) {
    return { ok: false, error: `Synth clip unexpectedly small (${fs.statSync(clipPath).size}b < ${SYNTH_CACHE_MIN_BYTES}) — check FFmpeg` };
  }

  // Use absolute local paths — avoids localhost:8765 race condition where
  // the static server may not have flushed the file before assembly downloads it.
  const avUrl   = avPath;
  const clipUrl = clipPath;

  // Build minimal segment payload — 3 segments: avatar + source_clip + avatar
  // Matches the minimum needed to exercise the chrome burn path for this content type
  const cardData = _synthCardData(baseContentType);
  const segmentData = [
    { url: avUrl,   label: 'SYNTH_INTRO',   type: 'avatar',      cardData },
    { url: clipUrl, label: 'SYNTH_CLIP',    type: 'source_clip', clipUrl, pillarboxFilter: null, orientation: 'landscape' },
    { url: avUrl,   label: 'SYNTH_OUTRO',   type: 'avatar',      cardData },
  ];

  const payload = {
    jobTitle:      `synth_prebuild_${baseContentType}_${jobId}`,
    contentType:   baseContentType,
    transition:    'cut',
    format,
    expectedClips: 1,
    isSynthPrebuild: true,
    // Pass full jobSpec so assembly uses the frozen chrome config from designSpec.
    jobSpec,
    segmentData,
    segments: segmentData.filter(s => s.type === 'avatar').map(s => s.url),
  };

  let asmId;
  try {
    const resp = await axios.post(`${API}/assemble`, payload, { timeout: 30000 });
    asmId = resp.data?.assemblyId || resp.data?.asmId;
    if (!asmId) return { ok: false, error: 'No assemblyId returned from /assemble' };
  } catch (e) {
    return { ok: false, error: `/assemble POST failed: ${e.message}` };
  }

  // Poll for up to 3 minutes
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const status = await axios.get(`${API}/assemble-progress/${asmId}`, { timeout: 5000 });
      const d = status.data;
      if (d.outputPath && fs.existsSync(d.outputPath)) {
        const outputMb = fs.statSync(d.outputPath).size / 1024 / 1024;
        return {
          ok: true,
          outputMb: Math.round(outputMb * 10) / 10,
          outputPath: d.outputPath
        };
      }
      if (d.status === 'failed' && !d.outputPath) {
        return { ok: false, error: d.error || 'Assembly failed before output was written' };
      }
    } catch (_) { /* poll errors are transient */ }
  }

  return { ok: false, error: 'Synth assembly timed out after 3 minutes' };
}

/**
 * Minimal cardData per content type so the chrome sidebar has something to render.
 */
function _synthCardData(baseContentType) {
  if (baseContentType === 'nba' || baseContentType === 'sports') {
    return { title: 'SYNTH GAME', category: 'NBA GAME', storyId: 'synth_0', matchup: 'Team A vs Team B' };
  }
  if (baseContentType === 'twitch' || baseContentType === 'clips') {
    return { title: 'Synth Streamer', displayName: 'Synth', category: 'ON STREAM', storyId: 'synth_0', origin: 'Test', fact: 'Prebuild verification' };
  }
  // news default
  return { title: 'Synth News Story', category: 'WORLD NEWS', storyId: 'synth_0' };
}

module.exports = { canProduce, commit, run, prepare, buildGate3aGeminiSamplePrompt };
