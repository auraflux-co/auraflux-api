'use strict';
/**
 * lib/gates/gate4.js — Gate 4 (Portal 4): Gemini Full Video Broadcast Ready
 *
 * Watches the COMPLETE assembled video. Its pass is the ONLY thing that authorizes
 * Portal 5 to fire. uploadSignal:true is the key output.
 *
 * Can pass with notes — notes surface to operator but do not block upload.
 * One sendback if fails — if second attempt fails → escalate human, job does not upload.
 *
 * Also exposes:
 *   preflightForUpload(assembledPath, jobSpec) — validate file integrity before Upload-Post
 *   resolveChromeSkinOverride(jobSpec) — read per-customer chrome color overrides from jobSpec
 *
 * Output contract:
 * {
 *   gate: 4,
 *   jobId: string,
 *   passed: boolean,
 *   broadcastReady: boolean,
 *   uploadSignal: boolean,
 *   preflightPassed: boolean,
 *   notes: [string],
 *   upstreamContext: { reviewedReports, confirmedClean, escalatedConcerns, downstreamHeadsUp },
 *   completedAt: ISO-8601
 * }
 */

const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { uploadToGeminiFiles, waitForGeminiFile, deleteGeminiFile } = require('../qa');
const { ffprobePath } = require('../ffmpeg_utils');
const { logError } = require('../error_logger');
const axios = require('axios');

// ─── Pre-flight validation ────────────────────────────────────────────────────

/**
 * Validate an assembled video file before handing off to Upload-Post (Portal 5).
 * Checks: file exists, minimum size, duration plausible, SHA-256 hash computable.
 *
 * Returns:
 * {
 *   passed: boolean,
 *   fileExists: boolean,
 *   sizeBytes: number,
 *   duration: number | null,
 *   sha256: string | null,
 *   failReason: string | null
 * }
 *
 * @param {string} assembledPath
 * @param {Object} [jobSpec]
 */
async function preflightForUpload(assembledPath, jobSpec) {
  const result = {
    passed: false,
    fileExists: false,
    sizeBytes: 0,
    duration: null,
    sha256: null,
    failReason: null,
  };

  if (!assembledPath) {
    result.failReason = 'preflightForUpload: assembledPath is null or undefined';
    logError('GATE4_PREFLIGHT_NO_PATH', new Error(result.failReason), {
      jobId: jobSpec?.jobId,
    });
    return result;
  }

  // Existence + size
  let stat;
  try {
    stat = fs.statSync(assembledPath);
    result.fileExists = true;
    result.sizeBytes = stat.size;
  } catch {
    result.failReason = `preflightForUpload: file not found at ${assembledPath}`;
    logError('GATE4_PREFLIGHT_FILE_MISSING', new Error(result.failReason), {
      jobId: jobSpec?.jobId,
      assembledPath,
    });
    return result;
  }

  if (result.sizeBytes < MIN_FILE_SIZE) {
    result.failReason = `preflightForUpload: file too small ${result.sizeBytes} bytes (minimum ${MIN_FILE_SIZE})`;
    logError('GATE4_PREFLIGHT_TOO_SMALL', new Error(result.failReason), {
      jobId: jobSpec?.jobId,
      sizeBytes: result.sizeBytes,
    });
    return result;
  }

  // Duration probe via ffprobe
  result.duration = await new Promise((resolve) => {
    execFile(
      ffprobePath(),
      [
        '-v', 'quiet',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=duration',
        '-of', 'csv=p=0',
        assembledPath,
      ],
      { timeout: 15000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const d = parseFloat(String(stdout).trim());
        resolve(Number.isFinite(d) && d > 0 ? d : null);
      }
    );
  });

  if (result.duration === null) {
    result.failReason = 'preflightForUpload: could not read video duration — file may be corrupt';
    logError('GATE4_PREFLIGHT_NO_DURATION', new Error(result.failReason), {
      jobId: jobSpec?.jobId,
      assembledPath,
    });
    return result;
  }

  // Sanity check: minimum 5 seconds
  if (result.duration < 5) {
    result.failReason = `preflightForUpload: video duration too short (${result.duration.toFixed(1)}s) — minimum 5s`;
    logError('GATE4_PREFLIGHT_SHORT_VIDEO', new Error(result.failReason), {
      jobId: jobSpec?.jobId,
      duration: result.duration,
    });
    return result;
  }

  // SHA-256 hash — confirms file is readable end-to-end
  result.sha256 = await new Promise((resolve) => {
    try {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(assembledPath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });

  if (!result.sha256) {
    result.failReason = 'preflightForUpload: SHA-256 hash failed — file unreadable or I/O error';
    logError('GATE4_PREFLIGHT_HASH_FAIL', new Error(result.failReason), {
      jobId: jobSpec?.jobId,
      assembledPath,
    });
    return result;
  }

  result.passed = true;
  return result;
}

// ─── Chrome skin overrides ────────────────────────────────────────────────────

/**
 * Resolve per-customer Chrome color overrides from the job spec.
 * Falls back to C0 ClipzWorld News defaults if nothing is set.
 *
 * Callers (assembly, chrome_overlay_ffmpeg) can read these values to
 * render the correct brand bar without modifying shared chromeDirectives.js.
 *
 * Returns:
 * {
 *   primaryColor: string,   // e.g. '#22304b'
 *   accentColor: string,    // e.g. '#c7af4f'
 *   textColor: string,      // e.g. '#ffffff'
 *   skinName: string        // e.g. 'ClipzWorld News'
 * }
 *
 * @param {Object} jobSpec
 */
function resolveChromeSkinOverride(jobSpec) {
  const C0_DEFAULTS = {
    primaryColor: '#22304b',
    accentColor: '#c7af4f',
    textColor: '#ffffff',
    skinName: 'ClipzWorld News',
  };

  const overrides = jobSpec?.designSpec?.chrome?.skinOverrides;
  if (!overrides || typeof overrides !== 'object') {
    // Fall through to customerId-based lookup
  }

  // Per-customer config: jobSpec.designSpec.chrome.skinOverrides takes highest precedence
  if (overrides) {
    return {
      primaryColor: overrides.primaryColor || C0_DEFAULTS.primaryColor,
      accentColor: overrides.accentColor || C0_DEFAULTS.accentColor,
      textColor: overrides.textColor || C0_DEFAULTS.textColor,
      skinName: overrides.skinName || C0_DEFAULTS.skinName,
    };
  }

  // Fallback: read from customer config skin field
  const skin = jobSpec?.designSpec?.chrome?.skin;
  if (skin === 'c0' || skin === 'clipzworld' || !skin) return C0_DEFAULTS;

  // Unknown skin — use C0 defaults and warn
  console.warn(
    `[gate4] resolveChromeSkinOverride: unknown skin "${skin}" for job ${jobSpec?.jobId} — using C0 defaults`
  );
  return { ...C0_DEFAULTS, skinName: skin };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_APIKEY = process.env.GEMINI_API_KEY;

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB (Gemini hard limit)
const MAX_GEMINI_UPLOAD_BYTES = 480 * 1024 * 1024; // 480MB safety margin
const MIN_FILE_SIZE = 100 * 1024; // 100KB

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
    reasons.push('No assembledPath in jobSpec — full assembled video path required');
  } else if (!fs.existsSync(assembledPath)) {
    reasons.push(`Assembled file not found: ${assembledPath}`);
  } else {
    const size = fs.statSync(assembledPath).size;
    if (size < MIN_FILE_SIZE) {
      reasons.push(`Assembled file too small: ${size} bytes`);
    }
    // Files between MAX_GEMINI_UPLOAD_BYTES and MAX_FILE_SIZE are handled in run() with Gate 3a fallback
    // Files > MAX_FILE_SIZE are rejected here (beyond what gate4 can handle even with fallback)
    else if (size > MAX_FILE_SIZE) {
      reasons.push(
        `Assembled file too large for Gemini Files API: ${(size / 1024 / 1024).toFixed(0)}MB > 500MB limit`
      );
    }
  }

  // Gate 3b must have passed
  // (caller is responsible for ensuring this, but we note it as a readiness signal)

  return { ready: reasons.length === 0, reasons };
}

// ─── commit ──────────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @returns {{ committed: string }}
 */
function commit(jobSpec) {
  const platforms = jobSpec?.deliverySpec?.platforms ||
    jobSpec?.order?.publish?.platforms || ['youtube'];
  return {
    committed: `I will watch the complete assembled video and confirm it is broadcast ready — overall pacing end to end, audio quality across full runtime, no compounding issues, content accuracy vs Gate 1 committed script summary, brand representation. I verify thumbnailDriveUrl is present in savedOutputs (thumbnail generated in parallel during Gate 3a) — missing thumbnail is a warning not a blocker. Pass authorizes upload to: ${platforms.join(', ')}.`,
  };
}

// ─── Upstream context builder ────────────────────────────────────────────────

/**
 * Build upstreamContext from prior gate reports — used for fallback paths.
 */
function buildUpstreamContext(priorGateReports) {
  const [gate0Report, gate1Report, gate2Report, gate3aReport, gate3bReport] =
    priorGateReports || [];
  return {
    reviewedReports: ['gate0', 'gate1', 'gate2', 'gate3a', 'gate3b'],
    confirmedClean: [
      ...(gate0Report?.upstreamContext?.confirmedClean || []),
      ...(gate1Report?.upstreamContext?.confirmedClean || []),
      ...(gate2Report?.upstreamContext?.confirmedClean || []),
      ...(gate3aReport?.upstreamContext?.confirmedClean || []),
      ...(gate3bReport?.upstreamContext?.confirmedClean || []),
    ],
    escalatedConcerns: [
      ...(gate0Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate1Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate2Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate3aReport?.upstreamContext?.escalatedConcerns || []),
      ...(gate3bReport?.upstreamContext?.escalatedConcerns || []),
    ],
    downstreamHeadsUp: null,
  };
}

// ─── Gemini analysis helper ───────────────────────────────────────────────────

/**
 * Send full video to Gemini for broadcast readiness review.
 */
async function analyzeFullVideo(fileUri, jobSpec, priorGateReports, jobId, platforms) {
  if (!GEMINI_APIKEY) return null;
  // Ensure platforms is always defined — read from jobSpec if not passed
  if (!platforms) platforms = jobSpec?.deliverySpec?.platforms || ['youtube'];

  const [gate0Report, gate1Report] = priorGateReports || [];
  const confirmedFormat = gate0Report?.confirmedFormat || '16:9';
  const confirmedSources = gate0Report?.confirmedSources || [];
  const scriptSummary = gate1Report?.scriptSummary || 'no script summary available';
  const isShort = (jobSpec?.order?.formType || '').includes('short');

  // Fix 9: Read contentType and chrome context from jobSpec — Gate 4 must know station brand
  const contentType = jobSpec?.contentType || jobSpec?.order?.contentType || 'unknown';
  const chromeName =
    jobSpec?.designSpec?.chrome?.name || jobSpec?.designSpec?.chrome?.skin || 'ClipzWorld News';
  const sceneHeaders = jobSpec?.designSpec?.sceneStructure?.sceneHeaders || [];
  const totalScenes = jobSpec?.designSpec?.sceneStructure?.expectedSceneCount || 0;
  const clipCount = jobSpec?.designSpec?.sceneStructure?.expectedClipCount ?? 0;
  const showName =
    contentType.includes('clips') || contentType.includes('twitch')
      ? 'TWITCH SOUP'
      : contentType.includes('sports') || contentType.includes('nba')
        ? 'OTHER SIDE OF THE PILLOW'
        : 'BECAUSE THE LIGHT WAS ON';

  let speakerName = 'the host';
  try {
    const { loadCustomerConfig } = require('../customerConfig');
    const _sCfg = loadCustomerConfig(
      jobSpec?.customerId || 'c0',
      isShort ? 'short-form' : 'long-form'
    );
    speakerName =
      _sCfg?.voice?.speakerName || _sCfg?.designDefaults?.voice?.speakerName || speakerName;
  } catch (_e) {}

  const sourceList =
    confirmedSources.map((s) => `- ${s.itemId}: ${s.url}`).join('\n') || 'No confirmed sources';
  const itemsOrdered =
    (jobSpec?.order?.inputs?.items || [])
      .map((it, i) => `${i + 1}. ${it.title || it.displayName || it.name || 'unknown'}`)
      .join(', ') || '(none available)';
  const categoryLabel =
    jobSpec?.designSpec?.voice?.categoryLabel ||
    jobSpec?.designSpec?.chrome?.categoryLabel ||
    'CATEGORY';

  // Build prior gate context for prompt
  const g3aReport = priorGateReports?.find
    ? priorGateReports.find((r) => r?.gate === 'gate3a')
    : priorGateReports?.gate3a;
  const g3bReport = priorGateReports?.find
    ? priorGateReports.find((r) => r?.gate === 'gate3b')
    : priorGateReports?.gate3b;
  const g2Report = priorGateReports?.find
    ? priorGateReports.find((r) => r?.gate === 'gate2')
    : priorGateReports?.gate2;

  const priorContext =
    [
      gate0Report?.passed ? `Gate 0: confirmed format=${confirmedFormat}, sources verified` : null,
      gate1Report?.passed ? `Gate 1: script passed style QA` : null,
      g2Report?.passed ? `Gate 2: all renders passed (score ${g2Report.score ?? 'n/a'})` : null,
      g3aReport?.passed
        ? `Gate 3a: assembly qualitative check passed (score ${g3aReport.score ?? 'n/a'})`
        : null,
      g3bReport?.passed ? `Gate 3b: commitment verification passed` : null,
      ...(g3aReport?.upstreamContext?.downstreamHeadsUp
        ? [`Gate 3a flagged for Gate 4: ${g3aReport.upstreamContext.downstreamHeadsUp}`]
        : []),
      ...(g3aReport?.sampleFindings
        ? Object.entries(g3aReport.sampleFindings)
            .filter(([, f]) => f?.issues?.length)
            .map(([label, f]) => `Gate 3a ${label} issues: ${f.issues.join('; ')}`)
        : []),
    ]
      .filter(Boolean)
      .join('\n') || 'No prior gate reports available';

  const prompt = `You are Gate 4 — the broadcast QA director and upload authorization gate for the AuraFlux video production pipeline.

CRITICAL IDENTITY: You are issuing an upload authorization. Your "uploadSignal: true" in the output JSON is the ONLY thing that authorizes this video to be published. Nothing else in the pipeline can override or bypass your decision. If you do not return "uploadSignal: true", the video will NOT be uploaded.

── HOW THIS ENTIRE JOB WAS PRODUCED ─────────────────────────────────────────
1. Gate 0 (ffprobe): confirmed source videos, detected format=${confirmedFormat}
2. Gate 1 (Claude): reviewed script style — voice, names, accuracy, outro
3. Gate 2 (ffprobe): confirmed all HeyGen avatar renders passed quality checks
4. HeyGen: rendered ${speakerName} avatar video segments from the approved script
5. FFmpeg assembly: concatenated avatar segments + source clips, burned broadcast chrome overlay + ticker
6. Gate 3a (Gemini): reviewed 3 sample points (EARLY/MIDDLE/LATE) for freeze, clips, audio, chrome
7. Gate 3b (Claude): verified assembly matched committed design spec
8. You are now reviewing the complete assembled video

YOUR GOAL: Issue an upload authorization if this video is broadcast ready. Your pass triggers upload to ${platforms.join(', ')}. Your fail triggers a targeted fix attempt — NOT a full re-render.

YOUR ROLE: You are the final quality authority. You watch the COMPLETE video, not samples. You confirm the whole product is ready for a real audience.

HOW TO CLOSE THE GAP (your fix directive approach):
- Pacing issue: describe exactly which section drags or rushes → assembly can trim or pad
- Audio issue: describe timestamp and nature → assembly re-normalizes that segment
- Compounding visual issue: describe what and where → assembly re-encodes that section
- Content accuracy issue: describe what commentary says vs what clip shows → Gate 1 sendback with clip analysis
- If broadcastReady=false: your "blockers" array must contain specific, actionable fixes — not generic descriptions
- Notes (non-blocking) surface to the operator but do NOT block upload

Take your time. Watch the entire video before forming any judgment. Minor imperfections that don't affect viewer experience should NOT block upload. Your standard is "would I be comfortable if this aired tonight?"

PATIENCE: If the video is still processing, loading, or buffering when you start watching, wait for it to fully load before evaluating. Do NOT fail or penalize for loading artifacts. Only evaluate what you see in stable, fully-loaded playback.

REMINDER: You must always return "uploadSignal" in your JSON — either true or false. Never omit it.

PRIOR GATE REPORTS — what every upstream gate confirmed:
${priorContext}

COMMITTED JOB SPEC:
- Format: ${confirmedFormat}
- Content type: ${contentType}
- Show name: ${showName}
- Is short-form: ${isShort}
- Station brand (always on ticker right side): ${chromeName} — this is CORRECT branding, never flag it
- Scene count: ${totalScenes || 'unknown'}, source clips: ${clipCount}
- Items ordered: ${itemsOrdered}
- Flag category label: "${categoryLabel}" — must appear on every avatar scene flag row 1
- Flag must update per scene: different item title on flag row 2 for each story/streamer/game
- Sidebar must show all ${(jobSpec?.order?.inputs?.items || []).length} item(s) with correct titles throughout: ${itemsOrdered}
- NOTE: Station branding on ticker right side is always correct. Only flag ticker if the scrolling content area is blank or broken.
- Confirmed source items:
${sourceList}
- Script summary: ${scriptSummary}

WATCH THE ENTIRE VIDEO and evaluate:
1. Pacing: appropriate end-to-end? no sections that drag or feel rushed?
2. Audio: consistent volume across full runtime? no dropouts, silence gaps, or level jumps?
3. Compounding issues: anything recurring across segments that Gate 3a's 3 samples might have missed?
4. Content accuracy: does ${speakerName}'s commentary match what's actually shown in the source clips?
5. Brand: consistent tone and style for this show throughout?
6. Flag accuracy: Does the top-left flag title CHANGE correctly as each story/streamer/game segment plays? Does it match the items listed above (${itemsOrdered})?
7. Sidebar accuracy: Do the sidebar cards show the correct item titles from the ordered list? Is the active card highlighted correctly as video progresses?
8. BROADCAST READY: comfortable airing this tonight?

VISUAL SPEC CHECKS — chrome is now FFmpeg drawtext/drawbox (no Puppeteer artifacts):
- Verify show name "${showName}" appears correctly in top bar throughout the video
- Verify top bar shows episode number on the left side and show name in the center throughout
- Verify flag (top-left, 620px wide, below top bar) updates per scene — different title for each story/streamer/game — must match: ${itemsOrdered}
- Verify sidebar (right side) shows story/streamer/game cards with correct titles matching what ${speakerName} discusses
- Verify logo is visible bottom-right throughout
- Flag any scene where flag title does not match what ${speakerName} is talking about (commentary vs flag mismatch)
- Flag any scene where chrome elements cover ${speakerName}'s face (flag is 88px tall at y=48 — OK; sidebar is right side only — OK)
- Note: Blue box artifacts and alpha corruption are eliminated in the new FFmpeg chrome engine. Report any visual anomalies regardless.
- flagAccurate=false is a BLOCKER — the wrong story/streamer/game title on the flag is a factual error visible to viewers.
- sidebarAccurate=false where titles are completely wrong is a BLOCKER — missing/wrong sidebar titles confuse viewers about what they're watching.

Return JSON only:
{
  "pacingOk": boolean,
  "audioQualityOk": boolean,
  "noCompoundingIssues": boolean,
  "contentAccurate": boolean,
  "brandConsistent": boolean,
  "chromeCorrect": boolean,
  "chromeNotes": "describe what you observe in the chrome (top bar, flag, sidebar, logo) across the full video — be specific",
  "flagAccurate": boolean,
  "flagNotes": "specific description of flag behavior vs expected — does it update per scene? does it show correct item titles?",
  "sidebarAccurate": boolean,
  "sidebarNotes": "specific description of sidebar vs expected — do cards show correct item titles from the ordered list?",
  "broadcastReady": boolean,
  "uploadSignal": boolean,
  "notes": ["non-blocking observations for the operator"],
  "blockers": ["BLOCKING issues — each must be specific and actionable with fix instruction, leave [] if none"],
  "score": 0-100
}

IMPORTANT: uploadSignal must always be present — set it to true if broadcastReady=true and blockers is empty, false otherwise. Never omit it.`;

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_APIKEY}`,
      {
        contents: [
          {
            role: 'user',
            parts: [{ fileData: { mimeType: 'video/mp4', fileUri } }, { text: prompt }],
          },
        ],
      },
      { timeout: 120000 } // Full video analysis needs more time
    );

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = text
      .replace(/^```[a-z]*\n?/i, '')
      .replace(/\n?```$/i, '')
      .trim();
    return JSON.parse(cleaned);
  } catch (err) {
    logError('GATE4_GEMINI_ERROR', err, { jobId, gate: 4 });
    return null;
  }
}

// ─── run ─────────────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @param {string} assembledPath
 * @param {Object[]} priorGateReports - [gate0, gate1, gate2, gate3a, gate3b]
 * @returns {Promise<Object>} GateOutput
 */
async function run(jobSpec, assembledPath, priorGateReports) {
  const jobId = jobSpec?.jobId || 'unknown';
  const now = () => new Date().toISOString();
  const platforms = jobSpec?.deliverySpec?.platforms ||
    jobSpec?.order?.publish?.platforms || ['youtube'];

  const [gate0Report, gate1Report, gate2Report, gate3aReport, gate3bReport] =
    priorGateReports || [];

  // Check thumbnail — generated in parallel during Gate 3a, should be ready by now
  const thumbnailDriveUrl = jobSpec?.state?.savedOutputs?.thumbnailDriveUrl || null;
  if (!thumbnailDriveUrl) {
    console.warn(
      `[gate4] thumbnailDriveUrl missing for job ${jobId} — Upload-Post will publish without custom thumbnail`
    );
  } else {
    console.log(`[gate4] thumbnailDriveUrl confirmed: ${thumbnailDriveUrl.slice(0, 60)}...`);
  }

  const upstreamContext = {
    reviewedReports: ['gate0', 'gate1', 'gate2', 'gate3a', 'gate3b'],
    confirmedClean: [
      ...(gate0Report?.upstreamContext?.confirmedClean || []),
      ...(gate1Report?.upstreamContext?.confirmedClean || []),
      ...(gate2Report?.upstreamContext?.confirmedClean || []),
      ...(gate3aReport?.upstreamContext?.confirmedClean || []),
      ...(gate3bReport?.upstreamContext?.confirmedClean || []),
    ],
    escalatedConcerns: [
      ...(gate0Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate1Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate2Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate3aReport?.upstreamContext?.escalatedConcerns || []),
      ...(gate3bReport?.upstreamContext?.escalatedConcerns || []),
    ],
    downstreamHeadsUp: null,
  };

  const baseOutput = {
    gate: 4,
    jobId,
    passed: false,
    broadcastReady: false,
    uploadSignal: false,
    preflightPassed: false,
    notes: [],
    upstreamContext,
    completedAt: now(),
  };

  const readiness = canProduce(jobSpec);
  if (!readiness.ready) {
    const reason = `Gate 4 not ready: ${readiness.reasons.join('; ')}`;
    logError('GATE4_NOT_READY', new Error(reason), { jobId, gate: 4 });
    return { ...baseOutput, notes: [reason], completedAt: now() };
  }

  // Gate 3b escalation blocks Gate 4 — fixable mismatches do not
  // mismatch_fixable = logged but assembly already matched spec closely enough to proceed
  // mismatch_escalate = fundamental spec violation, human review required
  if (gate3bReport?.outcome === 'mismatch_escalate') {
    const reason =
      'Gate 3b escalation — fundamental spec mismatch, upload signal NOT issued, human review required';
    logError('GATE4_GATE3B_ESCALATE', new Error(reason), { jobId, gate: 4 });
    return {
      ...baseOutput,
      notes: [reason],
      completedAt: now(),
    };
  }

  if (jobSpec?.expectedSynth) {
    const note =
      'expectedSynth/lab — Gate 4 full-video broadcast QA skipped; uploadSignal false until a production assemble';
    return {
      gate: 4,
      jobId,
      passed: true,
      outcome: 'pass_with_notes',
      score: 80,
      broadcastReady: false,
      uploadSignal: false,
      failReason: null,
      concerns: [],
      notes: [note],
      upstreamContext: {
        ...upstreamContext,
        confirmedClean: [...upstreamContext.confirmedClean, 'expectedSynth_skip'],
        downstreamHeadsUp: note,
      },
      completedAt: now(),
    };
  }

  const targetPath = assembledPath || jobSpec.assembledPath || jobSpec.outputPath;

  // ── Pre-flight validation ───────────────────────────────────────────────────
  // Run before Gemini upload — abort early on corrupt/missing file.
  const preflight = await preflightForUpload(targetPath, jobSpec);
  if (!preflight.passed) {
    logError('GATE4_PREFLIGHT_FAIL', new Error(preflight.failReason), { jobId, gate: 4 });
    return {
      ...baseOutput,
      preflightPassed: false,
      notes: [
        `Pre-flight check failed — halting before upload: ${preflight.failReason}`,
        'Job held for manual review. Do not submit to Upload-Post until file is verified.',
      ],
      completedAt: now(),
    };
  }

  console.log(
    `[gate4] Pre-flight passed for job ${jobId} — ${(preflight.sizeBytes / 1024 / 1024).toFixed(1)}MB, ${preflight.duration?.toFixed(1)}s, sha256=${preflight.sha256?.slice(0, 16)}...`
  );

  // Large file check — fall back to Gate 3a findings if file exceeds Gemini upload limit
  const fileSize = fs.existsSync(targetPath) ? fs.statSync(targetPath).size : 0;
  if (fileSize > MAX_GEMINI_UPLOAD_BYTES) {
    const g3aFindings = priorGateReports ? priorGateReports[3] : null;
    const g3aPassed = g3aFindings?.passed || false;
    const sizeLabel = `${(fileSize / 1024 / 1024).toFixed(0)}MB`;
    logError(
      'GATE4_FILE_TOO_LARGE_FALLBACK',
      new Error(
        `${sizeLabel} exceeds ${MAX_GEMINI_UPLOAD_BYTES / 1024 / 1024}MB Gemini limit — using Gate 3a fallback`
      ),
      { jobId, gate: 4, fileSize }
    );
    return {
      gate: 4,
      jobId,
      passed: g3aPassed,
      broadcastReady: g3aPassed,
      uploadSignal: g3aPassed,
      preflightPassed: true,
      preflightMeta: { sizeBytes: preflight.sizeBytes, duration: preflight.duration, sha256: preflight.sha256 },
      score: g3aPassed ? 75 : 50,
      notes: [
        `File size ${sizeLabel} exceeds Gemini upload limit — broadcast check based on Gate 3a findings`,
      ],
      upstreamContext: buildUpstreamContext(priorGateReports),
      completedAt: now(),
    };
  }

  // Upload full video to Gemini Files API
  let geminiFile;
  try {
    geminiFile = await uploadToGeminiFiles(targetPath);
    if (!geminiFile) throw new Error('Upload returned null');
    await waitForGeminiFile(geminiFile);
  } catch (err) {
    logError('GATE4_UPLOAD_FAIL', err, { jobId, gate: 4 });
    return {
      ...baseOutput,
      notes: [`Video upload to Gemini failed: ${err.message}. Job held — not auto-failed.`],
      completedAt: now(),
    };
  }

  // Analyze with Gemini
  const analysis = await analyzeFullVideo(
    geminiFile.uri,
    jobSpec,
    priorGateReports,
    jobId,
    platforms
  );

  // Clean up Gemini file
  try {
    await deleteGeminiFile(geminiFile.name);
  } catch {}

  if (!analysis) {
    // Gemini API error — hold job, do not auto-fail
    const note = 'Gemini analysis returned no result — job held for manual review';
    logError('GATE4_NO_ANALYSIS', new Error(note), { jobId, gate: 4 });
    return {
      ...baseOutput,
      notes: [note],
      completedAt: now(),
    };
  }

  let blockers = analysis.blockers || [];
  const notes = analysis.notes || [];

  // Treat flagAccurate=false as a BLOCKER — wrong title on flag is a factual error visible to viewers
  if (analysis.flagAccurate === false) {
    const flagBlocker = `Flag inaccurate: ${analysis.flagNotes || 'flag title does not match expected item titles'}. Fix: re-burn chrome overlay with correct item titles in sceneStructure.items[].label`;
    if (!blockers.includes(flagBlocker)) {
      blockers = [...blockers, flagBlocker];
    }
    logError('GATE4_FLAG_INACCURATE', new Error(flagBlocker), { jobId, gate: 4 });
  }

  // Treat sidebarAccurate=false as a BLOCKER — wrong sidebar titles confuse viewers
  if (analysis.sidebarAccurate === false) {
    const sidebarBlocker = `Sidebar inaccurate: ${analysis.sidebarNotes || 'sidebar cards show wrong item titles'}. Fix: re-burn chrome overlay with correct item titles in sceneStructure.items[].label`;
    if (!blockers.includes(sidebarBlocker)) {
      blockers = [...blockers, sidebarBlocker];
    }
    logError('GATE4_SIDEBAR_INACCURATE', new Error(sidebarBlocker), { jobId, gate: 4 });
  }

  const broadcastReady = analysis.broadcastReady === true && blockers.length === 0;
  const score = typeof analysis.score === 'number' ? analysis.score : broadcastReady ? 85 : 50;

  const passed = broadcastReady;
  // Prefer Gemini's explicit uploadSignal if present; fall back to derived value from broadcastReady.
  // Gate 5 checks gate4Report.uploadSignal === true (hard check) — must always be defined.
  // If we post-injected blockers (flagAccurate/sidebarAccurate), those override Gemini's signal.
  const geminiSignal = typeof analysis.uploadSignal === 'boolean' ? analysis.uploadSignal : passed;
  const uploadSignal = blockers.length > 0 ? false : geminiSignal;

  if (!passed) {
    const blockerText = blockers.length
      ? blockers.join('; ')
      : 'Broadcast not ready (no blockers listed)';
    logError('GATE4_NOT_BROADCAST_READY', new Error(`Blockers: ${blockerText}`), {
      jobId,
      gate: 4,
      score,
      blockers,
    });
  }

  const allNotes = [
    ...notes,
    ...blockers.map((b) => `BLOCKER: ${b}`),
    ...(upstreamContext.escalatedConcerns.length > 0
      ? [`Upstream concerns: ${upstreamContext.escalatedConcerns.join('; ')}`]
      : []),
  ];

  const failSummary = !passed
    ? blockers.length
      ? blockers.join('; ')
      : 'Broadcast not ready (no blockers listed in analysis)'
    : null;

  return {
    gate: 4,
    jobId,
    passed,
    outcome: passed ? 'pass' : 'hard_fail',
    score,
    broadcastReady,
    uploadSignal,
    preflightPassed: true,
    preflightMeta: {
      sizeBytes: preflight.sizeBytes,
      duration: preflight.duration,
      sha256: preflight.sha256,
    },
    failReason: failSummary,
    concerns: blockers,
    notes: allNotes,
    upstreamContext: {
      ...upstreamContext,
      confirmedClean: passed
        ? [...upstreamContext.confirmedClean, 'broadcast_ready']
        : upstreamContext.confirmedClean,
      escalatedConcerns: !passed
        ? [...upstreamContext.escalatedConcerns, ...blockers]
        : upstreamContext.escalatedConcerns,
      downstreamHeadsUp: notes.length > 0 ? `Gate 4 notes for operator: ${notes.join('; ')}` : null,
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
    // Pre-load GEMINI_API_KEY check
    if (!GEMINI_APIKEY) {
      console.warn(
        `[gate4] prepare() warning: GEMINI_API_KEY not set — full video analysis will fail for job ${jobId}`
      );
    }

    // Pre-read platforms from deliverySpec
    const platforms = jobSpec?.deliverySpec?.platforms ||
      jobSpec?.order?.publish?.platforms || ['youtube'];

    // Pre-read prior gate context template (what it will summarize from gate reports)
    const contextTemplate = {
      format: jobSpec?.order?.output?.format || '16:9',
      isShort: (jobSpec?.order?.formType || '').includes('short'),
      expectedSources: jobSpec?.order?.inputs?.items?.length || 0,
    };

    console.log(
      `[gate4] Ready for job ${jobId} — will authorize upload to ${platforms.join(', ')}`
    );
  } catch (e) {
    // Non-fatal — preparation failure never blocks the gate
    console.warn(`[gate4] prepare() warning: ${e.message}`);
  }
}

module.exports = { canProduce, commit, run, prepare, preflightForUpload, resolveChromeSkinOverride };
