'use strict';
/**
 * lib/routes/clip_sourcing.js — CPD-73: Clip sourcing API routes
 *
 * Routes:
 *   POST /jobs/:jobId/clip-candidates         — run suggestClips for a job
 *   POST /jobs/:jobId/clip-candidates/approve — approve subset, commit manifest to job spec
 *   GET  /jobs/:jobId/clip-candidates         — retrieve pending candidates for a job
 *
 * Design notes:
 *   - Candidates are stored transiently in memory keyed by jobId.
 *     A real production version would persist in PostgreSQL.
 *   - Manual approval is a hard platform invariant — fair-use compliance.
 *   - Approved clip manifest is written to jobSpec.uploadSpec.clipManifest.
 */

'use strict';

const router = require('express').Router();
const { requireAuth, requireRole, ROLES } = require('../auth');
const { apiLimit } = require('../rateLimiter');
const {
  suggestClips,
  approveClipCandidates,
  buildClipManifest,
} = require('../clip_sourcing');

// ─── In-memory candidate store (keyed by jobId) ───────────────────────────────
// TODO(cpd-73-phase2): replace with PostgreSQL table for durability

const candidateStore = new Map();

const auth = [requireAuth, requireRole(ROLES.customer)];

// ─── POST /jobs/:jobId/clip-candidates ────────────────────────────────────────
// Trigger clip analysis on uploaded footage for a job.
//
// Body: { showTitle, footagePath, script?, keywords?, maxCandidates? }
// Returns: { ok, jobId, candidates[], requiresApproval: true }

router.post('/jobs/:jobId/clip-candidates', auth, apiLimit, async (req, res) => {
  const { jobId } = req.params;
  const { showTitle, footagePath, script, keywords, maxCandidates } = req.body || {};

  if (!showTitle) {
    return res.status(400).json({ ok: false, error: 'showTitle is required', label: 'MISSING_SHOW_TITLE' });
  }
  if (!footagePath) {
    return res.status(400).json({ ok: false, error: 'footagePath is required', label: 'MISSING_FOOTAGE_PATH' });
  }

  try {
    const result = await suggestClips({
      showTitle,
      footagePath,
      script,
      keywords,
      maxCandidates,
      planTier: req.auth?.planTier || 'diy',
    });

    // Cache candidates for this job until approved/expired
    candidateStore.set(jobId, {
      ...result,
      createdAt: new Date().toISOString(),
    });

    return res.json({
      ok:               true,
      jobId,
      showTitle:        result.showTitle,
      candidates:       result.candidates,
      requiresApproval: true,
      suggestedAt:      result.suggestedAt,
      _isStub:          result._isStub || false,
    });
  } catch (err) {
    const label = err.message.includes('plan') ? 'PLAN_GATE' : 'CLIP_SOURCING_ERROR';
    const status = label === 'PLAN_GATE' ? 403 : 500;
    return res.status(status).json({ ok: false, error: err.message, label });
  }
});

// ─── GET /jobs/:jobId/clip-candidates ─────────────────────────────────────────
// Retrieve pending candidates previously generated for this job.

router.get('/jobs/:jobId/clip-candidates', auth, (req, res) => {
  const { jobId } = req.params;
  const entry = candidateStore.get(jobId);
  if (!entry) {
    return res.status(404).json({ ok: false, error: 'No candidates found for this job', label: 'NOT_FOUND' });
  }
  return res.json({ ok: true, jobId, ...entry });
});

// ─── POST /jobs/:jobId/clip-candidates/approve ────────────────────────────────
// Approve a subset of candidates and commit the manifest to the job spec.
//
// Body: { approvedIds: string[], footageStorageKey?: string }
// Returns: { ok, jobId, approved[], clipManifest[] }

router.post('/jobs/:jobId/clip-candidates/approve', auth, apiLimit, (req, res) => {
  const { jobId } = req.params;
  const { approvedIds = [], footageStorageKey } = req.body || {};

  if (!Array.isArray(approvedIds) || approvedIds.length === 0) {
    return res.status(400).json({ ok: false, error: 'approvedIds must be a non-empty array', label: 'MISSING_APPROVED_IDS' });
  }

  const entry = candidateStore.get(jobId);
  if (!entry) {
    return res.status(404).json({ ok: false, error: 'No candidates found for this job — run POST /clip-candidates first', label: 'NOT_FOUND' });
  }

  const { approved, rejected } = approveClipCandidates(entry.candidates, approvedIds);

  if (approved.length === 0) {
    return res.status(400).json({ ok: false, error: 'None of the provided IDs matched available candidates', label: 'NO_VALID_APPROVALS' });
  }

  const clipManifest = buildClipManifest(approved, { footageStorageKey });

  // Clear the candidate store entry — approval is a one-shot operation
  candidateStore.delete(jobId);

  return res.json({
    ok:           true,
    jobId,
    approved,
    rejected,
    clipManifest,
    approvedCount: approved.length,
    rejectedCount: rejected.length,
  });
});

module.exports = router;
module.exports.candidateStore = candidateStore; // exposed for testing
