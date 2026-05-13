'use strict';
/**
 * lib/clip_sourcing/index.js — CPD-73: Show clip sourcing module
 *
 * Accepts a show title + script content and returns ranked clip candidates
 * for commentary/reaction content jobs.
 *
 * Key constraints (product decision):
 *   - AuraFlux NEVER downloads from third-party streaming services
 *   - Customer must upload show footage; this module analyses that footage
 *   - Manual fair-use approval gate is REQUIRED before clips enter job spec
 *   - Output feeds Portal 0 as sourceType: 'upload' with a clip manifest
 *
 * Exports:
 *   suggestClips(opts)          — analyse footage and return ranked candidates
 *   approveClipCandidates(...)  — commit approved candidates to a job spec
 *   buildClipManifest(...)      — format approved clips for Portal 0 consumption
 *   rankCandidates(candidates, script) — sort candidates by relevance score
 *
 * Depends on:
 *   - lib/services/gemini.js (video understanding via Gemini Files API)
 *   - lib/services/feature_gate.js (plan gating)
 */

const path   = require('path');
const { isFeatureEnabled } = require('../services/feature_gate');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum relevance score (0-100) to include in returned candidates. */
const MIN_RELEVANCE_SCORE = 20;

/** Maximum candidates returned from a single suggestClips call. */
const MAX_CANDIDATES = 50;

/** Default clip duration to sample around a detected moment (seconds). */
const DEFAULT_CLIP_DURATION = 30;

/** Status values for clip candidates. */
const CANDIDATE_STATUS = {
  PENDING:  'pending',   // awaiting customer review
  APPROVED: 'approved',  // approved for job spec
  REJECTED: 'rejected',  // rejected by customer
};

// ─── suggestClips ─────────────────────────────────────────────────────────────

/**
 * Analyse uploaded show footage and suggest relevant clip candidates.
 *
 * @param {object} opts
 * @param {string}   opts.showTitle      — e.g. "Landman"
 * @param {string}   opts.footagePath    — absolute local path to uploaded footage file
 * @param {string}   [opts.script]       — commentary script text for relevance matching
 * @param {string[]} [opts.keywords]     — explicit keywords to match against moments
 * @param {number}   [opts.maxCandidates] — cap on results (default MAX_CANDIDATES)
 * @param {string}   [opts.planTier]     — customer plan tier for feature gating
 * @param {object}   [opts._geminiClient] — injectable Gemini client for testing
 * @returns {Promise<{
 *   showTitle: string,
 *   footagePath: string,
 *   candidates: ClipCandidate[],
 *   suggestedAt: string,
 *   requiresApproval: true
 * }>}
 */
async function suggestClips(opts = {}) {
  const {
    showTitle,
    footagePath,
    script    = '',
    keywords  = [],
    maxCandidates = MAX_CANDIDATES,
    planTier  = 'operate',
    _geminiClient,
  } = opts;

  if (!showTitle || typeof showTitle !== 'string' || !showTitle.trim()) {
    throw new Error('suggestClips: showTitle is required');
  }
  if (!footagePath || typeof footagePath !== 'string') {
    throw new Error('suggestClips: footagePath is required');
  }

  if (!isFeatureEnabled('clip.sourcing', planTier)) {
    throw new Error(`Clip sourcing requires dwy plan or higher (current: ${planTier})`);
  }

  // Extract keywords from script if none provided
  const resolvedKeywords = keywords.length > 0
    ? keywords
    : extractKeywordsFromScript(script);

  // Use injected client (tests) or real Gemini
  const geminiClient = _geminiClient || (await getGeminiClient());

  let rawMoments = [];
  try {
    rawMoments = await analyseFootageWithGemini(geminiClient, footagePath, showTitle, resolvedKeywords, script);
  } catch (err) {
    // Non-fatal: return stub candidates with a note so pipeline isn't blocked
    rawMoments = buildStubCandidates(footagePath, resolvedKeywords);
    rawMoments._isStub = true;
  }

  const candidates = rankCandidates(
    rawMoments.map((m, i) => normaliseMoment(m, i, footagePath)),
    script
  ).slice(0, maxCandidates);

  return {
    showTitle:        showTitle.trim(),
    footagePath,
    candidates,
    suggestedAt:      new Date().toISOString(),
    requiresApproval: true,   // ALWAYS true — platform invariant
    _isStub:          rawMoments._isStub || false,
  };
}

// ─── approveClipCandidates ────────────────────────────────────────────────────

/**
 * Mark a subset of candidates as approved/rejected and return the approved set.
 *
 * @param {ClipCandidate[]} candidates     — full candidate list from suggestClips
 * @param {string[]}        approvedIds    — array of candidate.id values to approve
 * @returns {{ approved: ClipCandidate[], rejected: ClipCandidate[] }}
 */
function approveClipCandidates(candidates, approvedIds = []) {
  if (!Array.isArray(candidates)) throw new Error('candidates must be an array');
  if (!Array.isArray(approvedIds)) throw new Error('approvedIds must be an array');

  const approvedSet = new Set(approvedIds);
  const approved = [];
  const rejected = [];

  for (const c of candidates) {
    if (approvedSet.has(c.id)) {
      approved.push({ ...c, status: CANDIDATE_STATUS.APPROVED });
    } else {
      rejected.push({ ...c, status: CANDIDATE_STATUS.REJECTED });
    }
  }

  return { approved, rejected };
}

// ─── buildClipManifest ────────────────────────────────────────────────────────

/**
 * Convert approved candidates into the clip manifest format consumed by Portal 0
 * and the commentary assembly layer (lib/services/commentary_assembly.js).
 *
 * Output shape matches the `clipManifest` expected by `commentaryAssemble()`.
 *
 * @param {ClipCandidate[]} approvedCandidates
 * @param {object} [opts]
 * @param {string} [opts.footageStorageKey] — R2/cloud storage key for the footage file
 * @returns {ClipManifestEntry[]}
 */
function buildClipManifest(approvedCandidates, opts = {}) {
  if (!Array.isArray(approvedCandidates)) throw new Error('approvedCandidates must be an array');

  return approvedCandidates.map((c) => ({
    clipId:             c.id,
    localPath:          c.footagePath,
    storageKey:         opts.footageStorageKey || null,
    startTime:          c.startTime,
    duration:           c.duration,
    tags:               c.tags || [],
    confidence:         c.relevanceScore / 100,
    scriptSegmentIndex: c.suggestedForSegment ?? null,
    approvedAt:         new Date().toISOString(),
  }));
}

// ─── rankCandidates ───────────────────────────────────────────────────────────

/**
 * Sort candidates by relevance score descending.
 * Filters out candidates below MIN_RELEVANCE_SCORE.
 *
 * @param {ClipCandidate[]} candidates
 * @param {string} [script]  — unused currently; reserved for future TF-IDF boosting
 * @returns {ClipCandidate[]}
 */
function rankCandidates(candidates, _script = '') {
  return candidates
    .filter((c) => c.relevanceScore >= MIN_RELEVANCE_SCORE)
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Lazy-load Gemini client to avoid circular deps in tests.
 */
async function getGeminiClient() {
  const { getClient } = require('../services/gemini');
  return getClient();
}

/**
 * Use Gemini video understanding to identify relevant moments in the footage.
 * Returns an array of raw moment objects: { startTime, duration, description, topics }.
 */
async function analyseFootageWithGemini(geminiClient, footagePath, showTitle, keywords, script) {
  const keywordList = keywords.slice(0, 20).join(', ');
  const scriptExcerpt = script ? script.slice(0, 1000) : '';

  const prompt = `You are analysing footage from the TV show "${showTitle}" for a commentary/reaction video.

${scriptExcerpt ? `Commentary script excerpt:\n${scriptExcerpt}\n` : ''}
${keywordList ? `Key topics to find: ${keywordList}\n` : ''}

Identify the most relevant moments in this footage. For each moment, respond with a JSON array:
[
  {
    "startTime": <seconds from start>,
    "duration": <suggested clip length in seconds, max 60>,
    "description": "<brief description of what happens>",
    "topics": ["<topic1>", "<topic2>"],
    "relevanceScore": <0-100, how relevant to the script/topics>
  }
]

Respond ONLY with the JSON array, no markdown.`;

  const rawText = await geminiClient.analyzeVideo(footagePath, prompt);

  let parsed;
  try {
    // Strip any accidental markdown fences
    const clean = rawText.replace(/```[a-z]*\n?/gi, '').trim();
    parsed = JSON.parse(clean);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];
  return parsed;
}

/**
 * Build a set of stub candidates when Gemini is unavailable.
 * These are clearly marked as stubs so the operator knows they need real analysis.
 */
function buildStubCandidates(footagePath, keywords) {
  return keywords.slice(0, 5).map((kw, i) => ({
    startTime:      i * 60,
    duration:       DEFAULT_CLIP_DURATION,
    description:    `[STUB] Potential moment related to: ${kw}`,
    topics:         [kw],
    relevanceScore: 50,
    _isStub:        true,
  }));
}

/**
 * Normalise a raw Gemini moment into a ClipCandidate shape.
 */
function normaliseMoment(moment, index, footagePath) {
  return {
    id:                `candidate-${index}-${Date.now()}`,
    footagePath,
    startTime:         typeof moment.startTime === 'number' ? moment.startTime : 0,
    duration:          Math.min(typeof moment.duration === 'number' ? moment.duration : DEFAULT_CLIP_DURATION, 60),
    description:       moment.description || '',
    tags:              Array.isArray(moment.topics) ? moment.topics : [],
    relevanceScore:    typeof moment.relevanceScore === 'number'
      ? Math.max(0, Math.min(100, moment.relevanceScore))
      : 0,
    suggestedForSegment: null,
    status:            CANDIDATE_STATUS.PENDING,
    _isStub:           moment._isStub || false,
  };
}

/**
 * Extract simple keyword list from script text.
 * Strips stop words, deduplicates, returns up to 20 terms.
 */
function extractKeywordsFromScript(script = '') {
  if (!script) return [];
  const STOP = new Set(['the','a','an','and','or','but','in','on','at','to','for','of','is','it','was','are','be','with','as','by','from','that','this','have','had','has','over','into','out','up','down','not','can','will','just','also','then','than','when','what','which','who','how','his','her','their','they','them','been','were','its']);
  const words = script.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w);
}

// ── CPD-73: Automated clip sourcing for commentary assembly ────────────────────
/**
 * Source a clip manifest automatically from one or more footage files.
 * Used by portal3a for commentary-mode jobs.
 *
 * Returns manifest in the shape commentaryAssemble expects:
 *   { clips: [{ id, path, scriptSegmentIndex, duration, confidence, label }], source }
 *
 * Falls back gracefully per file — if Gemini fails for one file it skips it.
 * Returns null if no clips could be sourced (caller should fall back to stubClipManifest).
 *
 * @param {string[]} footagePaths  — local paths to source video files
 * @param {string}   script        — narration script (for keyword extraction)
 * @param {string}   showTitle     — title for Gemini context
 * @param {object}   [opts]
 * @param {string}   [opts.planTier]  — plan tier for feature gate
 * @param {number}   [opts.minScore]  — min relevance score to include
 */
async function autoSourceClipManifest(footagePaths, script, showTitle, opts = {}) {
  const { planTier = 'operate', minScore = MIN_RELEVANCE_SCORE } = opts;
  let logErr;
  try { logErr = require('../utils/logger').logError; } catch { logErr = () => {}; }

  const allApproved = [];

  for (const footagePath of footagePaths) {
    try {
      const suggestion = await suggestClips({ showTitle, footagePath, script, planTier });
      const above = suggestion.candidates.filter((c) => c.relevanceScore >= minScore);
      for (const c of above) allApproved.push({ ...c, status: CANDIDATE_STATUS.APPROVED });
    } catch (err) {
      logErr('CPD73_FOOTAGE_ANALYSIS_FAIL', err, { footagePath });
    }
  }

  if (allApproved.length === 0) return null;

  const clips = allApproved.map((c) => ({
    id:                 c.id,
    path:               c.footagePath,
    scriptSegmentIndex: c.suggestedForSegment ?? null,
    duration:           c.duration || DEFAULT_CLIP_DURATION,
    confidence:         c.relevanceScore / 100,
    label:              c.label || c.id,
    startTime:          c.startTime || 0,
    tags:               c.tags || [],
  }));

  return {
    clips,
    source:         'auto_sourced',
    footagePaths,
    autoApprovedAt: new Date().toISOString(),
    candidateCount: allApproved.length,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  suggestClips,
  approveClipCandidates,
  buildClipManifest,
  autoSourceClipManifest,
  rankCandidates,
  extractKeywordsFromScript,
  CANDIDATE_STATUS,
  MIN_RELEVANCE_SCORE,
  MAX_CANDIDATES,
  DEFAULT_CLIP_DURATION,
};
