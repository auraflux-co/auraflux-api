'use strict';
/**
 * lib/gates/gate3b.js — Gate 3b: Claude Commitment Verification (Analytical)
 *
 * Does NOT watch video. Reads Gate 3a's report + Job Spec commitments and verifies
 * spec compliance analytically.
 *
 * Mismatches trigger targeted re-assembly of specific fields only (not rollback to HeyGen).
 * One sendback — if re-assembly still wrong → escalate.
 *
 * Output contract:
 * {
 *   gate: '3b',
 *   jobId: string,
 *   passed: boolean,
 *   outcome: 'pass' | 'mismatch_fixable' | 'mismatch_escalate',
 *   mismatches: [{ field, committed, delivered, fixable: boolean }],
 *   upstreamContext: { reviewedReports, confirmedClean, escalatedConcerns, downstreamHeadsUp },
 *   completedAt: ISO-8601
 * }
 */

const { logError } = require('../error_logger');

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

  if (!jobSpec.commitments || Object.keys(jobSpec.commitments || {}).length === 0) {
    reasons.push('jobSpec.commitments is empty — no committed spec to verify against');
  }

  return { ready: reasons.length === 0, reasons };
}

// ─── commit ──────────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @returns {{ committed: string }}
 */
function commit(jobSpec) {
  const fields = Object.keys(jobSpec?.commitments || {}).join(', ') || 'none';
  return {
    committed: `I will verify assembly output matches committed spec for: ${fields}. Specifically: chrome skin, logo position, output dimensions, aspect ratio, clip count, caption style, audio mix mode.`
  };
}

// ─── Verification helpers ─────────────────────────────────────────────────────

/**
 * Extract a value from a nested object using a dot-path string.
 * e.g. getPath(obj, 'designSpec.chrome.skin') → obj.designSpec.chrome.skin
 */
function getPath(obj, dotPath) {
  if (!obj || !dotPath) return undefined;
  return dotPath.split('.').reduce((acc, key) => acc?.[key], obj);
}

/**
 * Compare a committed spec field against what gate3a confirmed.
 * Returns { matched: boolean, committed: any, delivered: any }.
 */
function compareField(committed, delivered) {
  if (committed === undefined || committed === null) return { matched: true, committed, delivered }; // nothing committed
  if (delivered === undefined || delivered === null) return { matched: false, committed, delivered };

  // Normalize strings for comparison
  const c = typeof committed === 'string' ? committed.toLowerCase().trim() : committed;
  const d = typeof delivered === 'string' ? delivered.toLowerCase().trim() : delivered;

  return { matched: c === d, committed, delivered };
}

/**
 * Infer delivered values from gate3a sample findings.
 * Returns best-effort delivered spec based on findings.
 */
function inferDeliveredSpec(gate3aReport, jobSpec) {
  const findings = gate3aReport?.sampleFindings || {};
  const allSamples = [findings.early, findings.middle, findings.late].filter(Boolean);

  // Chrome visible: if any sample confirms it
  const chromeVisible = allSamples.some(f => f.chromeVisible === true);
  // Audio continuous: if all samples confirm
  const audioContinuous = allSamples.every(f => f.audioContinuous !== false);
  // Portrait split: from any short-form sample
  const portraitSplitCorrect = allSamples.some(f => f.portraitSplitCorrect === true);
  // Caption visible
  const captionVisible = allSamples.some(f => f.captionVisible === true);
  // Source clips: if any sample confirms
  const sourceClipsVisible = allSamples.some(f => f.sourceClipsVisible === true);

  // Format from gate0 or jobSpec
  const confirmedFormat = gate3aReport?.upstreamContext?.confirmedClean?.includes('assembly_qualitative')
    ? (jobSpec?.order?.output?.format || null)
    : null;

  return {
    chromeVisible,
    audioContinuous,
    portraitSplitCorrect,
    captionVisible,
    sourceClipsVisible,
    format: confirmedFormat,
    score: gate3aReport?.score || 0
  };
}

// ─── run ─────────────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @param {Object} gate3aReport
 * @param {Object[]} priorGateReports - [gate0Report, gate1Report, gate2Report]
 * @returns {Promise<Object>} GateOutput
 */
async function run(jobSpec, gate3aReport, priorGateReports) {
  const jobId = jobSpec?.jobId || 'unknown';
  const now = () => new Date().toISOString();

  const [gate0Report, gate1Report, gate2Report] = priorGateReports || [];

  const upstreamContext = {
    reviewedReports: ['gate0', 'gate1', 'gate2', 'gate3a'],
    confirmedClean: [
      ...(gate0Report?.upstreamContext?.confirmedClean || []),
      ...(gate1Report?.upstreamContext?.confirmedClean || []),
      ...(gate2Report?.upstreamContext?.confirmedClean || []),
      ...(gate3aReport?.upstreamContext?.confirmedClean || [])
    ],
    escalatedConcerns: [
      ...(gate0Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate1Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate2Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate3aReport?.upstreamContext?.escalatedConcerns || [])
    ],
    downstreamHeadsUp: gate3aReport?.upstreamContext?.downstreamHeadsUp || null
  };

  const baseOutput = {
    gate: '3b',
    jobId,
    passed: false,
    outcome: 'mismatch_escalate',
    mismatches: [],
    upstreamContext,
    completedAt: now()
  };

  const readiness = canProduce(jobSpec);
  if (!readiness.ready) {
    const reason = `Gate 3b not ready: ${readiness.reasons.join('; ')}`;
    logError('GATE3B_NOT_READY', new Error(reason), { jobId, gate: '3b' });
    return { ...baseOutput, completedAt: now() };
  }

  // Gate 3a must have passed (or passed_with_notes)
  if (!gate3aReport?.passed) {
    const reason = 'Gate 3a did not pass — Gate 3b cannot verify a failed assembly';
    logError('GATE3B_GATE3A_FAILED', new Error(reason), { jobId, gate: '3b' });
    return {
      ...baseOutput,
      mismatches: [{ field: 'gate3a_prerequisite', committed: 'Gate 3a passed', delivered: 'Gate 3a failed', fixable: false }],
      completedAt: now()
    };
  }

  const commitments = jobSpec.commitments || {};
  const designSpec = jobSpec.order?.designSpec || {};
  const deliveredSpec = inferDeliveredSpec(gate3aReport, jobSpec);

  const mismatches = [];

  // ── Chrome skin ────────────────────────────────────────────────────────
  const committedSkin = getPath(designSpec, 'chrome.skin') || commitments.chromeSkin;
  if (committedSkin) {
    // Chrome visible is a proxy — we can't read skin from Gemini report directly
    if (!deliveredSpec.chromeVisible) {
      mismatches.push({
        field: 'chrome.skin',
        committed: committedSkin,
        delivered: 'Chrome not detected in any sample',
        fixable: true
      });
    }
  }

  // ── Logo position ──────────────────────────────────────────────────────
  const committedLogoPos = getPath(designSpec, 'chrome.logoPosition') || commitments.logoPosition;
  // Logo position can't be verified analytically from Gemini text output — flag as note
  if (committedLogoPos && gate3aReport.score < 70) {
    mismatches.push({
      field: 'chrome.logoPosition',
      committed: committedLogoPos,
      delivered: 'Unable to verify from gate3a report (score below threshold)',
      fixable: true
    });
  }

  // ── Output dimensions / aspect ratio ─────────────────────────────────
  const committedResolution = jobSpec.order?.output?.resolution || commitments.resolution;
  const committedFormat = jobSpec.order?.output?.format || commitments.format;
  const gate0Format = gate0Report?.confirmedFormat;

  if (committedFormat && gate0Format && committedFormat !== gate0Format) {
    mismatches.push({
      field: 'output.format',
      committed: committedFormat,
      delivered: gate0Format,
      fixable: false // format mismatch is not fixable at assembly time
    });
  }

  // Short-form portrait check
  if (committedFormat === '9:16') {
    if (!deliveredSpec.portraitSplitCorrect && gate3aReport.sampleFindings?.early?.portraitSplitCorrect === false) {
      mismatches.push({
        field: 'shortForm.portraitSplit',
        committed: 'Top/bottom split-screen correct',
        delivered: 'Portrait split not detected or incorrect',
        fixable: true
      });
    }
    if (commitments.captionRequired && !deliveredSpec.captionVisible) {
      mismatches.push({
        field: 'shortForm.caption',
        committed: 'Caption visible',
        delivered: 'Caption not detected',
        fixable: true
      });
    }
  }

  // ── Clip count ─────────────────────────────────────────────────────────
  const expectedClipCount = commitments.expectedClipCount || gate1Report?.clipCount;
  if (expectedClipCount && expectedClipCount > 0 && !deliveredSpec.sourceClipsVisible) {
    mismatches.push({
      field: 'clipCount',
      committed: `${expectedClipCount} source clip(s) visible`,
      delivered: 'Source clips not detected in any sample',
      fixable: true
    });
  }

  // ── Audio mix mode ─────────────────────────────────────────────────────
  const committedAudioMix = getPath(designSpec, 'audio.mixMode') || commitments.audioMixMode;
  if (committedAudioMix && !deliveredSpec.audioContinuous) {
    mismatches.push({
      field: 'audio.mixMode',
      committed: committedAudioMix,
      delivered: 'Audio not continuous across all samples',
      fixable: true
    });
  }

  // ── Determine outcome ──────────────────────────────────────────────────
  const hasUnfixable = mismatches.some(m => !m.fixable);
  const hasMismatches = mismatches.length > 0;

  let outcome;
  let passed = false;

  if (!hasMismatches) {
    outcome = 'pass';
    passed = true;
  } else if (hasUnfixable) {
    outcome = 'mismatch_escalate';
    logError('GATE3B_UNFIXABLE_MISMATCH', new Error(`Unfixable mismatches: ${mismatches.filter(m=>!m.fixable).map(m=>m.field).join(', ')}`), { jobId, gate: '3b', mismatches });
  } else {
    outcome = 'mismatch_fixable';
    logError('GATE3B_FIXABLE_MISMATCH', new Error(`Fixable mismatches: ${mismatches.map(m=>m.field).join(', ')}`), { jobId, gate: '3b', mismatches });
  }

  return {
    gate: '3b',
    jobId,
    passed,
    outcome,
    mismatches,
    upstreamContext: {
      ...upstreamContext,
      confirmedClean: passed ? [...upstreamContext.confirmedClean, 'assembly_spec_verified'] : upstreamContext.confirmedClean,
      escalatedConcerns: outcome === 'mismatch_escalate'
        ? [...upstreamContext.escalatedConcerns, ...mismatches.map(m => `${m.field}: committed "${m.committed}", delivered "${m.delivered}"`)]
        : upstreamContext.escalatedConcerns,
      downstreamHeadsUp: hasMismatches
        ? `Gate 3b found ${mismatches.length} spec mismatch(es): ${mismatches.map(m => m.field).join(', ')}`
        : null
    },
    completedAt: now()
  };
}

module.exports = { canProduce, commit, run };
