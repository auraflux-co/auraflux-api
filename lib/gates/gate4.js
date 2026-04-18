'use strict';
/**
 * lib/gates/gate4.js — Gate 4: Gemini Full Video Broadcast Ready
 *
 * Watches the COMPLETE assembled video. Its pass is the ONLY thing that authorizes
 * Gate 5 to fire. uploadSignal:true is the key output.
 *
 * Can pass with notes — notes surface to operator but do not block upload.
 * One sendback if fails — if second attempt fails → escalate human, job does not upload.
 *
 * Output contract:
 * {
 *   gate: 4,
 *   jobId: string,
 *   passed: boolean,
 *   broadcastReady: boolean,
 *   uploadSignal: boolean,
 *   notes: [string],
 *   upstreamContext: { reviewedReports, confirmedClean, escalatedConcerns, downstreamHeadsUp },
 *   completedAt: ISO-8601
 * }
 */

const fs = require('fs');
const { uploadToGeminiFiles, waitForGeminiFile, deleteGeminiFile } = require('../qa');
const { logError } = require('../error_logger');
const axios = require('axios');

// ─── Constants ───────────────────────────────────────────────────────────────

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_APIKEY = process.env.GEMINI_API_KEY;

const MAX_FILE_SIZE = 500 * 1024 * 1024;         // 500MB (Gemini hard limit)
const MAX_GEMINI_UPLOAD_BYTES = 480 * 1024 * 1024; // 480MB safety margin
const MIN_FILE_SIZE = 100 * 1024;                  // 100KB

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
      reasons.push(`Assembled file too large for Gemini Files API: ${(size / 1024 / 1024).toFixed(0)}MB > 500MB limit`);
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
  const platforms = jobSpec?.order?.publish?.platforms || ['youtube'];
  return {
    committed: `I will watch the complete assembled video and confirm it is broadcast ready — overall pacing end to end, audio quality across full runtime, no compounding issues, content accuracy vs Gate 1 committed script summary, brand representation. Pass authorizes upload to: ${platforms.join(', ')}.`
  };
}

// ─── Upstream context builder ────────────────────────────────────────────────

/**
 * Build upstreamContext from prior gate reports — used for fallback paths.
 */
function buildUpstreamContext(priorGateReports) {
  const [gate0Report, gate1Report, gate2Report, gate3aReport, gate3bReport] = priorGateReports || [];
  return {
    reviewedReports: ['gate0', 'gate1', 'gate2', 'gate3a', 'gate3b'],
    confirmedClean: [
      ...(gate0Report?.upstreamContext?.confirmedClean || []),
      ...(gate1Report?.upstreamContext?.confirmedClean || []),
      ...(gate2Report?.upstreamContext?.confirmedClean || []),
      ...(gate3aReport?.upstreamContext?.confirmedClean || []),
      ...(gate3bReport?.upstreamContext?.confirmedClean || [])
    ],
    escalatedConcerns: [
      ...(gate0Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate1Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate2Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate3aReport?.upstreamContext?.escalatedConcerns || []),
      ...(gate3bReport?.upstreamContext?.escalatedConcerns || [])
    ],
    downstreamHeadsUp: null
  };
}

// ─── Gemini analysis helper ───────────────────────────────────────────────────

/**
 * Send full video to Gemini for broadcast readiness review.
 */
async function analyzeFullVideo(fileUri, jobSpec, priorGateReports, jobId) {
  if (!GEMINI_APIKEY) return null;

  const [gate0Report, gate1Report] = priorGateReports || [];
  const confirmedFormat = gate0Report?.confirmedFormat || '16:9';
  const confirmedSources = gate0Report?.confirmedSources || [];
  const scriptSummary = gate1Report?.scriptSummary || 'no script summary available';
  const isShort = (jobSpec?.order?.formType || '').includes('short');

  const sourceList = confirmedSources.map(s => `- ${s.itemId}: ${s.url}`).join('\n') || 'No confirmed sources';

  const prompt = `You are a broadcast QA director reviewing a complete assembled news/reaction video for upload to YouTube/TikTok/Instagram.

Video specs:
- Format: ${confirmedFormat}
- Is short-form: ${isShort}
- Confirmed source items:
${sourceList}

Script summary: ${scriptSummary}

Watch the ENTIRE video (do not sample — watch all of it) and evaluate:
1. Pacing: is the overall pacing appropriate end-to-end? (no dragging, no abrupt rushes)
2. Audio quality: consistent volume? no dropouts? no sudden cuts to silence?
3. Compounding issues: any recurring problems the 3-sample check might have missed?
4. Content accuracy: does the commentary match what's actually shown in the source clips?
5. Brand representation: is this consistent with the show brand and tone?
6. Broadcast readiness: would you approve this for immediate upload without changes?

Return JSON only:
{
  "pacingOk": boolean,
  "audioQualityOk": boolean,
  "noCompoundingIssues": boolean,
  "contentAccurate": boolean,
  "brandConsistent": boolean,
  "broadcastReady": boolean,
  "notes": ["list any issues worth operator awareness, even if not blocking"],
  "blockers": ["list any issues that BLOCK upload — leave empty if none"],
  "score": 0-100
}`;

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
      { timeout: 120000 } // Full video analysis needs more time
    );

    const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
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

  const [gate0Report, gate1Report, gate2Report, gate3aReport, gate3bReport] = priorGateReports || [];

  const upstreamContext = {
    reviewedReports: ['gate0', 'gate1', 'gate2', 'gate3a', 'gate3b'],
    confirmedClean: [
      ...(gate0Report?.upstreamContext?.confirmedClean || []),
      ...(gate1Report?.upstreamContext?.confirmedClean || []),
      ...(gate2Report?.upstreamContext?.confirmedClean || []),
      ...(gate3aReport?.upstreamContext?.confirmedClean || []),
      ...(gate3bReport?.upstreamContext?.confirmedClean || [])
    ],
    escalatedConcerns: [
      ...(gate0Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate1Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate2Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate3aReport?.upstreamContext?.escalatedConcerns || []),
      ...(gate3bReport?.upstreamContext?.escalatedConcerns || [])
    ],
    downstreamHeadsUp: null
  };

  const baseOutput = {
    gate: 4,
    jobId,
    passed: false,
    broadcastReady: false,
    uploadSignal: false,
    notes: [],
    upstreamContext,
    completedAt: now()
  };

  const readiness = canProduce(jobSpec);
  if (!readiness.ready) {
    const reason = `Gate 4 not ready: ${readiness.reasons.join('; ')}`;
    logError('GATE4_NOT_READY', new Error(reason), { jobId, gate: 4 });
    return { ...baseOutput, notes: [reason], completedAt: now() };
  }

  // Gate 3b must have passed
  if (!gate3bReport?.passed) {
    const reason = 'Gate 3b did not pass — Gate 4 blocked, upload signal NOT issued';
    logError('GATE4_GATE3B_REQUIRED', new Error(reason), { jobId, gate: 4 });
    return {
      ...baseOutput,
      notes: [reason],
      completedAt: now()
    };
  }

  const targetPath = assembledPath || jobSpec.assembledPath || jobSpec.outputPath;

  // Large file check — fall back to Gate 3a findings if file exceeds Gemini upload limit
  const fileSize = fs.existsSync(targetPath) ? fs.statSync(targetPath).size : 0;
  if (fileSize > MAX_GEMINI_UPLOAD_BYTES) {
    const g3aFindings = priorGateReports ? priorGateReports[3] : null;
    const g3aPassed = g3aFindings?.passed || false;
    const sizeLabel = `${(fileSize / 1024 / 1024).toFixed(0)}MB`;
    logError('GATE4_FILE_TOO_LARGE_FALLBACK', new Error(`${sizeLabel} exceeds ${MAX_GEMINI_UPLOAD_BYTES/1024/1024}MB Gemini limit — using Gate 3a fallback`), { jobId, gate: 4, fileSize });
    return {
      gate: 4,
      jobId,
      passed: g3aPassed,
      broadcastReady: g3aPassed,
      uploadSignal: g3aPassed,
      score: g3aPassed ? 75 : 50,
      notes: [`File size ${sizeLabel} exceeds Gemini upload limit — broadcast check based on Gate 3a findings`],
      upstreamContext: buildUpstreamContext(priorGateReports),
      completedAt: now()
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
      completedAt: now()
    };
  }

  // Analyze with Gemini
  const analysis = await analyzeFullVideo(geminiFile.uri, jobSpec, priorGateReports, jobId);

  // Clean up Gemini file
  try { await deleteGeminiFile(geminiFile.name); } catch {}

  if (!analysis) {
    // Gemini API error — hold job, do not auto-fail
    const note = 'Gemini analysis returned no result — job held for manual review';
    logError('GATE4_NO_ANALYSIS', new Error(note), { jobId, gate: 4 });
    return {
      ...baseOutput,
      notes: [note],
      completedAt: now()
    };
  }

  const blockers = analysis.blockers || [];
  const notes = analysis.notes || [];
  const broadcastReady = analysis.broadcastReady === true && blockers.length === 0;
  const score = typeof analysis.score === 'number' ? analysis.score : (broadcastReady ? 85 : 50);

  const passed = broadcastReady;
  const uploadSignal = passed;

  if (!passed) {
    logError('GATE4_NOT_BROADCAST_READY', new Error(`Blockers: ${blockers.join('; ')}`), {
      jobId, gate: 4, score, blockers
    });
  }

  const allNotes = [
    ...notes,
    ...blockers.map(b => `BLOCKER: ${b}`),
    ...(upstreamContext.escalatedConcerns.length > 0
      ? [`Upstream concerns: ${upstreamContext.escalatedConcerns.join('; ')}`]
      : [])
  ];

  return {
    gate: 4,
    jobId,
    passed,
    broadcastReady,
    uploadSignal,
    notes: allNotes,
    upstreamContext: {
      ...upstreamContext,
      confirmedClean: passed ? [...upstreamContext.confirmedClean, 'broadcast_ready'] : upstreamContext.confirmedClean,
      escalatedConcerns: !passed
        ? [...upstreamContext.escalatedConcerns, ...blockers]
        : upstreamContext.escalatedConcerns,
      downstreamHeadsUp: notes.length > 0 ? `Gate 4 notes for operator: ${notes.join('; ')}` : null
    },
    completedAt: now()
  };
}

module.exports = { canProduce, commit, run };
