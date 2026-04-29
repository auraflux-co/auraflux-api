'use strict';
/**
 * C1+ Job Entry Endpoint — POST /jobs
 *
 * Accepts three entry types:
 *   fetch    — URL-based source (Portal 0 confirms via ffprobe/Gemini)
 *   upload   — Pre-uploaded file (fileId in R2, Portal 1 skipped via stageMap)
 *   generate — Text-to-video or image-to-video via RunPod/WAN
 *
 * All entry types create a job spec, persist to the DB, and dispatch
 * asynchronously through runPortalSequence(). Returns job ID immediately.
 *
 * CPD-67
 */

const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { apiLimit } = require('../rateLimiter');
const { createJobSpec } = require('../job_spec');
const { seedJobSpecFromScript } = require('../db');
const { logError } = require('../error_logger');

// ── Validation rules per entry type ──────────────────────────────────────────

const VALID_CONTENT_TYPES = ['news', 'clips', 'sports', 'short', 'custom'];
const VALID_TEMPLATE_IDS = ['long-form', 'short-form'];

const baseValidations = [
  body('entry')
    .isIn(['fetch', 'upload', 'generate'])
    .withMessage('entry must be fetch, upload, or generate'),
  body('contentType')
    .isIn(VALID_CONTENT_TYPES)
    .withMessage(`contentType must be one of: ${VALID_CONTENT_TYPES.join(', ')}`),
  body('customerId').isString().notEmpty().withMessage('customerId is required'),
  body('templateId')
    .optional()
    .isIn(VALID_TEMPLATE_IDS)
    .withMessage(`templateId must be one of: ${VALID_TEMPLATE_IDS.join(', ')}`),
];

const fetchValidations = [
  ...baseValidations,
  body('url').if(body('entry').equals('fetch')).isURL().withMessage('url must be a valid URL'),
];

const uploadValidations = [
  ...baseValidations,
  body('fileId')
    .if(body('entry').equals('upload'))
    .isString()
    .notEmpty()
    .withMessage('fileId is required for upload entry'),
];

const generateValidations = [
  ...baseValidations,
  body('type')
    .if(body('entry').equals('generate'))
    .isIn(['text', 'image'])
    .withMessage('type must be text or image for generate entry'),
  body('prompt')
    .if(body('entry').equals('generate'))
    .if(body('type').equals('text'))
    .isString()
    .notEmpty()
    .withMessage('prompt is required for generate/text'),
  body('imageId')
    .if(body('entry').equals('generate'))
    .if(body('type').equals('image'))
    .isString()
    .notEmpty()
    .withMessage('imageId is required for generate/image'),
];

// ── Route ─────────────────────────────────────────────────────────────────────

/**
 * POST /jobs
 *
 * Creates a new job spec and dispatches it to the portal pipeline.
 * Returns immediately with jobId; pipeline runs asynchronously.
 */
router.post(
  '/jobs',
  apiLimit,
  fetchValidations,
  uploadValidations,
  generateValidations,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ ok: false, errors: errors.array() });
    }

    const {
      entry,
      contentType,
      customerId,
      templateId = 'long-form',
      title,
      scheduledAt,
    } = req.body;

    let sourceType;
    let sourceConfig = {};
    let stageMapOverride = {};

    if (entry === 'fetch') {
      sourceType = 'url_list';
      sourceConfig = { urls: [req.body.url] };
    } else if (entry === 'upload') {
      sourceType = 'upload';
      sourceConfig = { uploadSessionId: req.body.fileId };
      stageMapOverride = {
        script: { active: false, provider: null, approvalMode: 'auto', skippedReason: 'upload_entry_own_script' },
      };
    } else if (entry === 'generate') {
      sourceType = 'wan_gen';
      const genType = req.body.type;
      sourceConfig =
        genType === 'text'
          ? { prompt: req.body.prompt, genType: 'text' }
          : { imageId: req.body.imageId, genType: 'image' };
    }

    let jobSpec;
    try {
      jobSpec = createJobSpec({
        customerId,
        templateId,
        contentType,
        sourceType,
        sourceConfig,
        title: title || `${contentType} — ${entry} — ${new Date().toISOString().slice(0, 10)}`,
        scheduledAt: scheduledAt || null,
        createdBy: 'api',
        stageMap: stageMapOverride,
      });
    } catch (err) {
      logError('CPD67_JOBSPEC_CREATE_FAIL', err, { entry, contentType, customerId });
      return res.status(400).json({ ok: false, error: err.message });
    }

    const jobId = jobSpec.jobId;

    try {
      seedJobSpecFromScript(jobId, jobSpec);
    } catch (err) {
      logError('CPD67_DB_SEED_FAIL', err, { jobId });
      return res.status(500).json({ ok: false, error: 'Failed to persist job', detail: err.message });
    }

    // Record the entry type on the job spec for observability.
    jobSpec.order = jobSpec.order || {};
    jobSpec.order.inputs = jobSpec.order.inputs || {};
    jobSpec.order.inputs.entry = entry;
    if (entry === 'fetch') jobSpec.order.inputs.url = req.body.url;
    if (entry === 'upload') jobSpec.order.inputs.fileId = req.body.fileId;
    if (entry === 'generate') {
      jobSpec.order.inputs.genType = req.body.type;
      jobSpec.order.inputs.prompt = req.body.prompt || null;
      jobSpec.order.inputs.imageId = req.body.imageId || null;
    }

    // Dispatch to portal pipeline asynchronously — returns job ID immediately.
    setImmediate(() => {
      try {
        const { runPortalSequence } = require('../gate_policy_runner');
        const workers = _resolvePortalWorkers();
        runPortalSequence(jobSpec, workers, {
          onPortalStart: ({ portalKey }) =>
            console.log(`[jobs/c1] ${jobId}: portal ${portalKey} started`),
          onPortalPass: ({ portalKey }) =>
            console.log(`[jobs/c1] ${jobId}: portal ${portalKey} passed`),
          onPortalFail: ({ portalKey, reason }) =>
            logError('CPD67_PORTAL_FAIL', reason || 'non-compliant', { jobId, portalKey }),
          onJobComplete: () => console.log(`[jobs/c1] ${jobId}: pipeline complete`),
          onJobFailed: ({ reason }) => logError('CPD67_JOB_FAILED', reason, { jobId }),
          persistJobStatus: (id, status) => {
            try {
              const { saveJob } = require('../db');
              saveJob(id, { ...jobSpec, status, updatedAt: new Date().toISOString() });
            } catch (_e) {}
          },
        });
      } catch (err) {
        logError('CPD67_DISPATCH_FAIL', err, { jobId });
      }
    });

    return res.status(202).json({
      ok: true,
      jobId,
      entry,
      sourceType,
      contentType,
      customerId,
      status: 'accepted',
      message: 'Job accepted. Pipeline is running asynchronously.',
    });
  }
);

// ── Portal worker resolver ────────────────────────────────────────────────────

/**
 * Resolve the portal worker map from lib/portals/*.
 * Workers are loaded lazily here so the route file boots fast even
 * if individual portal modules have heavy imports.
 */
function _resolvePortalWorkers() {
  return {
    portal0: require('../portals/portal0'),
    portal1: require('../portals/portal1'),
    portal1b: require('../portals/portal1_video_reviewer'),
    portal2: require('../portals/portal2'),
    portal3a: require('../portals/portal3a'),
    portal3b: require('../portals/portal3b'),
    portal4: require('../portals/portal4'),
    portal5: require('../portals/portal5'),
  };
}

module.exports = router;
