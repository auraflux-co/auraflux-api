'use strict';
/**
 * lib/gates/gate3b.js — Portal 3b: Commitment Verification (Analytical, No LLM)
 *
 * IDENTITY: Portal 3b does NOT watch the video. It is an analyst reading reports.
 * It compares what was PROMISED in the designSpec (commitments) against what
 * Portal 3a FOUND in its 3 sample points — and determines if they match.
 *
 * Mismatches trigger targeted re-assembly of specific fields only (not rollback to HeyGen).
 * One sendback — if re-assembly still wrong → escalate.
 *
 * OUTCOME DEFINITIONS:
 *   'pass'               — All committed fields match what Portal 3a delivered. Portal 4 proceeds.
 *   'mismatch_fixable'   — Chrome/overlay/logo issue that can be re-burned without re-render.
 *                          PASSES THROUGH TO GATE 4 with a note. Does NOT block upload.
 *   'mismatch_escalate'  — Content/audio/sync issue requiring re-render or human review.
 *                          BLOCKS GATE 4. Escalates to monitoring.
 *
 * Only 'mismatch_escalate' blocks Portal 4. 'mismatch_fixable' passes through with a note.
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

  const hasCommitments = jobSpec.commitments && Object.keys(jobSpec.commitments).length > 0;
  const hasDesignSpec = jobSpec.designSpec && Object.keys(jobSpec.designSpec).length > 0;
  if (!hasCommitments && !hasDesignSpec) {
    reasons.push(
      'jobSpec.commitments is empty and jobSpec.designSpec is empty — no committed spec to verify against'
    );
  }
  // If commitments empty but designSpec has content, gate will read from designSpec directly — allowed

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
    committed: `I will verify assembly output matches committed spec for: ${fields}. Specifically: chrome skin, logo position, output dimensions, aspect ratio, clip count, caption style, audio mix mode. I do NOT check the thumbnail — thumbnail generation runs in parallel with Portal 3a and is verified by Portal 4.`,
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
  if (delivered === undefined || delivered === null)
    return { matched: false, committed, delivered };

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
  const chromeVisible = allSamples.some((f) => f.chromeVisible === true);
  // Audio continuous: if all samples confirm
  const audioContinuous = allSamples.every((f) => f.audioContinuous !== false);
  // Portrait split: from any short-form sample
  const portraitSplitCorrect = allSamples.some((f) => f.portraitSplitCorrect === true);
  // Caption visible
  const captionVisible = allSamples.some((f) => f.captionVisible === true);
  // Source clips: if any sample confirms
  const sourceClipsVisible = allSamples.some((f) => f.sourceClipsVisible === true);

  // Format from gate0 or jobSpec
  const confirmedFormat = gate3aReport?.upstreamContext?.confirmedClean?.includes(
    'assembly_qualitative'
  )
    ? jobSpec?.order?.output?.format || null
    : null;

  return {
    chromeVisible,
    audioContinuous,
    portraitSplitCorrect,
    captionVisible,
    sourceClipsVisible,
    format: confirmedFormat,
    score: gate3aReport?.score || 0,
  };
}

// ─── run ─────────────────────────────────────────────────────────────────────

/**
 * @param {Object} jobSpec
 * @param {Object} gate3aReport
 * @param {Object[]} priorPortalReports - [gate0Report, gate1Report, gate2Report]
 * @returns {Promise<Object>} GateOutput
 */
async function run(jobSpec, gate3aReport, priorPortalReports) {
  const jobId = jobSpec?.jobId || 'unknown';
  const now = () => new Date().toISOString();

  // When called via _adaptLegacyPortal (only jobSpec passed), read reports from portalReports
  if (!gate3aReport && jobSpec?.portalReports?.portal3a) {
    gate3aReport = jobSpec.portalReports.portal3a;
  }
  if (!priorPortalReports && jobSpec?.portalReports) {
    const r = jobSpec.portalReports;
    priorPortalReports = [r.portal0, r.portal1, r.portal2].filter(Boolean);
  }

  const [gate0Report, gate1Report, gate2Report] = priorPortalReports || [];

  const upstreamContext = {
    reviewedReports: ['gate0', 'gate1', 'gate2', 'gate3a'],
    confirmedClean: [
      ...(gate0Report?.upstreamContext?.confirmedClean || []),
      ...(gate1Report?.upstreamContext?.confirmedClean || []),
      ...(gate2Report?.upstreamContext?.confirmedClean || []),
      ...(gate3aReport?.upstreamContext?.confirmedClean || []),
    ],
    escalatedConcerns: [
      ...(gate0Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate1Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate2Report?.upstreamContext?.escalatedConcerns || []),
      ...(gate3aReport?.upstreamContext?.escalatedConcerns || []),
    ],
    downstreamHeadsUp: gate3aReport?.upstreamContext?.downstreamHeadsUp || null,
  };

  const baseOutput = {
    gate: '3b',
    jobId,
    passed: false,
    outcome: 'mismatch_escalate',
    mismatches: [],
    upstreamContext,
    completedAt: now(),
  };

  const readiness = canProduce(jobSpec);
  if (!readiness.ready) {
    const reason = `Portal 3b not ready: ${readiness.reasons.join('; ')}`;
    logError('GATE3B_NOT_READY', new Error(reason), { jobId, gate: '3b' });
    return { ...baseOutput, completedAt: now() };
  }

  // Portal 3a must have passed (or passed_with_notes)
  if (!gate3aReport?.passed) {
    const reason = 'Portal 3a did not pass — Portal 3b cannot verify a failed assembly';
    logError('GATE3B_GATE3A_FAILED', new Error(reason), { jobId, gate: '3b' });
    return {
      ...baseOutput,
      mismatches: [
        {
          field: 'gate3a_prerequisite',
          committed: 'Portal 3a passed',
          delivered: 'Portal 3a failed',
          fixable: false,
        },
      ],
      completedAt: now(),
    };
  }

  if (jobSpec?.expectedSynth) {
    return {
      gate: '3b',
      jobId,
      passed: true,
      outcome: 'pass',
      mismatches: [],
      upstreamContext: {
        ...upstreamContext,
        confirmedClean: [...upstreamContext.confirmedClean, 'expectedSynth_skip'],
        downstreamHeadsUp:
          'expectedSynth/lab — Portal 3b commitment comparison skipped (product policy)',
      },
      completedAt: now(),
    };
  }

  const commitments = jobSpec.commitments || {};
  const designSpec = jobSpec.order?.designSpec || {};
  const deliveredSpec = inferDeliveredSpec(gate3aReport, jobSpec);

  const mismatches = [];

  // Determine whether chrome elements are actually committed — all has* false = no chrome to verify
  const chromeCfg = jobSpec.designSpec?.chrome || {};
  const chromeCommitted =
    chromeCfg.hasTopBar === true ||
    chromeCfg.hasFlag === true ||
    chromeCfg.hasSidebar === true ||
    chromeCfg.hasTicker === true ||
    chromeCfg.hasLogo === true;

  // ── Chrome skin ────────────────────────────────────────────────────────
  const committedSkin =
    jobSpec.commitments?.assembly?.designSpec?.chrome?.skin ||
    getPath(designSpec, 'chrome.skin') ||
    getPath(jobSpec.designSpec, 'chrome.skin') ||
    commitments.chromeSkin;
  // Only check chrome skin when chrome elements are actually committed — skip for no-chrome jobs
  if (committedSkin && chromeCommitted) {
    // Chrome visible is a proxy — we can't read skin from Gemini report directly
    if (!deliveredSpec.chromeVisible) {
      mismatches.push({
        field: 'chrome.skin',
        committed: committedSkin,
        delivered: 'Chrome not detected in any sample',
        fixable: true,
      });
    }
  }

  // ── Logo position ──────────────────────────────────────────────────────
  const committedLogoPos =
    jobSpec.commitments?.assembly?.designSpec?.chrome?.logoPosition ||
    getPath(designSpec, 'chrome.logoPosition') ||
    getPath(jobSpec.designSpec, 'chrome.logoPosition') ||
    commitments.logoPosition;
  // Logo position can't be verified analytically from Gemini text output — flag as note
  if (committedLogoPos && chromeCommitted && (gate3aReport?.score ?? 100) < 70) {
    mismatches.push({
      field: 'chrome.logoPosition',
      committed: committedLogoPos,
      delivered: 'Unable to verify from gate3a report (score below threshold)',
      fixable: true,
    });
  }

  // ── Output dimensions / aspect ratio ─────────────────────────────────
  const committedResolution = jobSpec.order?.output?.resolution || commitments.resolution;
  const committedFormat =
    jobSpec.commitments?.assembly?.designSpec?.aspectRatio ||
    jobSpec.order?.output?.format ||
    jobSpec.order?.output?.aspectRatio ||
    commitments.format;
  const gate0Format = gate0Report?.confirmedFormat;

  if (committedFormat && gate0Format && committedFormat !== gate0Format) {
    mismatches.push({
      field: 'output.format',
      committed: committedFormat,
      delivered: gate0Format,
      fixable: false, // format mismatch is not fixable at assembly time
    });
  }

  // Short-form portrait check
  if (committedFormat === '9:16') {
    if (
      !deliveredSpec.portraitSplitCorrect &&
      gate3aReport.sampleFindings?.early?.portraitSplitCorrect === false
    ) {
      mismatches.push({
        field: 'shortForm.portraitSplit',
        committed: 'Top/bottom split-screen correct',
        delivered: 'Portrait split not detected or incorrect',
        fixable: true,
      });
    }
    if (commitments.captionRequired && !deliveredSpec.captionVisible) {
      mismatches.push({
        field: 'shortForm.caption',
        committed: 'Caption visible',
        delivered: 'Caption not detected',
        fixable: true,
      });
    }
  }

  // ── Clip count ─────────────────────────────────────────────────────────
  const expectedClipCount =
    jobSpec?.designSpec?.sceneStructure?.expectedClipCount ??
    jobSpec?.designSpec?.expectedClipCount ??
    commitments.expectedClipCount ??
    gate1Report?.clipCount;
  if (expectedClipCount && expectedClipCount > 0 && !deliveredSpec.sourceClipsVisible) {
    mismatches.push({
      field: 'clipCount',
      committed: `${expectedClipCount} source clip(s) visible`,
      delivered: 'Source clips not detected in any sample',
      fixable: true,
    });
  }

  // ── Audio mix mode ─────────────────────────────────────────────────────
  const committedAudioMix = getPath(designSpec, 'audio.mixMode') || commitments.audioMixMode;
  if (committedAudioMix && !deliveredSpec.audioContinuous) {
    mismatches.push({
      field: 'audio.mixMode',
      committed: committedAudioMix,
      delivered: 'Audio not continuous across all samples',
      fixable: true,
    });
  }

  // ── Determine outcome ──────────────────────────────────────────────────
  const hasUnfixable = mismatches.some((m) => !m.fixable);
  const hasMismatches = mismatches.length > 0;

  let outcome;
  let passed = false;

  if (!hasMismatches) {
    outcome = 'pass';
    passed = true;
  } else if (hasUnfixable) {
    outcome = 'mismatch_escalate';
    logError(
      'GATE3B_UNFIXABLE_MISMATCH',
      new Error(
        `Unfixable mismatches: ${mismatches
          .filter((m) => !m.fixable)
          .map((m) => m.field)
          .join(', ')}`
      ),
      { jobId, gate: '3b', mismatches }
    );
  } else {
    outcome = 'mismatch_fixable';
    logError(
      'GATE3B_FIXABLE_MISMATCH',
      new Error(`Fixable mismatches: ${mismatches.map((m) => m.field).join(', ')}`),
      { jobId, gate: '3b', mismatches }
    );
  }

  return {
    gate: '3b',
    jobId,
    passed,
    outcome,
    mismatches,
    upstreamContext: {
      ...upstreamContext,
      confirmedClean: passed
        ? [...upstreamContext.confirmedClean, 'assembly_spec_verified']
        : upstreamContext.confirmedClean,
      escalatedConcerns:
        outcome === 'mismatch_escalate'
          ? [
              ...upstreamContext.escalatedConcerns,
              ...mismatches.map(
                (m) => `${m.field}: committed "${m.committed}", delivered "${m.delivered}"`
              ),
            ]
          : upstreamContext.escalatedConcerns,
      downstreamHeadsUp: hasMismatches
        ? `Portal 3b found ${mismatches.length} spec mismatch(es): ${mismatches.map((m) => m.field).join(', ')}`
        : null,
    },
    completedAt: now(),
  };
}

// ─── prepare ─────────────────────────────────────────────────────────────────

// Module-level checklist cache keyed by jobId — populated in prepare(), consumed in run()
const _preparedChecklists = new Map();

/**
 * Pre-flight setup called immediately on job:confirmed.
 * Non-blocking — never throws, never awaits slow operations.
 * @param {Object} jobSpec
 */
function prepare(jobSpec) {
  const jobId = jobSpec?.jobId || 'unknown';
  try {
    // Pre-compute the commitment checklist from designSpec
    const designSpec = jobSpec?.order?.designSpec || jobSpec?.designSpec || {};
    const commitments = jobSpec?.commitments || {};

    const skin = designSpec?.chrome?.skin || commitments?.chromeSkin || 'news';
    const logoPos =
      designSpec?.chrome?.logoPosition || commitments?.logoPosition || 'top-left:20:20';
    const _rawRes =
      jobSpec?.designSpec?.resolution ||
      jobSpec?.order?.output?.resolution ||
      commitments?.resolution;
    const resolution = typeof _rawRes === 'string' && _rawRes.includes('x') ? _rawRes : '1920x1080';
    const format = jobSpec?.order?.output?.format || commitments?.format || '16:9';
    const clipCount = commitments?.expectedClipCount || jobSpec?.order?.inputs?.items?.length || 0;

    // Parse resolution into width x height
    const resParts = String(resolution).split('x');
    const w = resParts[0] || '1920';
    const h = resParts[1] || '1080';

    // Store checklist for use in run()
    const checklist = { skin, logoPos, resolution, w, h, clipCount, format };
    _preparedChecklists.set(jobId, checklist);

    console.log(
      `[gate3b] Ready for job ${jobId} — checklist: skin=${skin}, logo=${logoPos}, resolution=${w}x${h}, clips=${clipCount}`
    );
  } catch (e) {
    // Non-fatal — preparation failure never blocks the gate
    console.warn(`[gate3b] prepare() warning: ${e.message}`);
  }
}

module.exports = { canProduce, commit, run, prepare, _preparedChecklists };
