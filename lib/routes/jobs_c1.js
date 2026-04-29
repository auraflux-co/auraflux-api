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
const { requireAuth, requireRole, ROLES } = require('../auth');

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
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
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
      addOns = {},
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
        addOns,
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
    // For wan_gen jobs: WAN generation fires first (CPD-69), then portal sequence runs.
    setImmediate(async () => {
      try {
        if (sourceType === 'wan_gen') {
          const preGenOk = await _runWanPreGeneration(jobSpec, jobId);
          if (!preGenOk) {
            logError('CPD69_WAN_PREGEN_FAILED', 'WAN pre-generation failed — aborting pipeline', { jobId });
            return;
          }
        }

        const { runPortalSequence } = require('../gate_policy_runner');
        const workers = _resolvePortalWorkers();
        runPortalSequence({
          jobSpec,
          portalWorkers: workers,
          extensionWorkers: _resolveExtensionWorkers(),
          onPortalStart: (portalKey) =>
            console.log(`[jobs/c1] ${jobId}: portal ${portalKey} started`),
          onPortalPass: (portalKey) =>
            console.log(`[jobs/c1] ${jobId}: portal ${portalKey} passed`),
          onPortalFail: (portalKey, result) =>
            logError('CPD67_PORTAL_FAIL', result?.reason || 'non-compliant', { jobId, portalKey }),
          onJobComplete: () => console.log(`[jobs/c1] ${jobId}: pipeline complete`),
          onJobFailed: (failedPortal, result) =>
            logError('CPD67_JOB_FAILED', result?.reason || failedPortal, { jobId }),
          persistJobStatus: ({ portalKey: pKey, policy, phase }) => {
            try {
              const { saveJob } = require('../db');
              saveJob(jobId, {
                ...jobSpec,
                status: phase,
                currentPortal: pKey,
                updatedAt: new Date().toISOString(),
              });
            } catch (_e) {}
          },
        }); // runPortalSequence
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

// ── WAN pre-generation (CPD-69) ────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

/**
 * Run WAN (RunPod/ComfyUI) video generation before the portal sequence.
 * Only called for jobs with sourceType='wan_gen'.
 *
 * T2V: uses wan_t2v_workflow.json + positivePrompt from order.inputs.sourceConfig.prompt
 * I2V: requires wan_i2v_workflow.json (not yet available — falls through as T2V fallback)
 *
 * On completion, writes output video path to jobSpec.order.inputs.items[] so Portal 0
 * can run ffprobe source confirmation on the generated file.
 *
 * @returns {boolean} true if generation succeeded, false if failed
 */
async function _runWanPreGeneration(jobSpec, jobId) {
  const sourceConfig = jobSpec?.order?.inputs?.sourceConfig || {};
  const genType = sourceConfig.genType || 'text';
  const prompt = sourceConfig.prompt || '';
  const outputPrefix = `wan_${jobId}`;

  if (!prompt && genType === 'text') {
    logError('CPD69_WAN_NO_PROMPT', new Error('prompt required for T2V'), { jobId });
    return false;
  }

  let generateWanVideo, pollComfyResult, downloadComfyOutput;
  try {
    ({ generateWanVideo, pollComfyResult, downloadComfyOutput } = require('../ai/runpod'));
  } catch (e) {
    logError('CPD69_RUNPOD_UNAVAILABLE', e, { jobId });
    return false;
  }

  try {
    console.log(`[jobs/c1] ${jobId}: starting WAN ${genType.toUpperCase()} generation`);
    const promptId = await generateWanVideo({
      positivePrompt: prompt,
      outputPrefix,
      width: sourceConfig.width || 832,
      height: sourceConfig.height || 480,
      numFrames: sourceConfig.numFrames || 25,
      seed: sourceConfig.seed,
    });

    console.log(`[jobs/c1] ${jobId}: WAN queued (promptId=${promptId}) — polling`);
    const outputs = await pollComfyResult(promptId);

    const filenames = [];
    for (const out of Object.values(outputs || {})) {
      for (const fileList of Object.values(out)) {
        for (const f of Array.isArray(fileList) ? fileList : [fileList]) {
          if (f?.filename) filenames.push(f.filename);
        }
      }
    }

    if (!filenames.length) {
      logError('CPD69_WAN_NO_OUTPUT', new Error('WAN completed but no output files'), { jobId, promptId });
      return false;
    }

    const tmpDir = path.join(__dirname, '..', '..', 'tmp', 'wan_gen');
    fs.mkdirSync(tmpDir, { recursive: true });

    const localPaths = [];
    for (const filename of filenames) {
      const buf = await downloadComfyOutput(filename);
      const localPath = path.join(tmpDir, `${jobId}_${filename}`);
      fs.writeFileSync(localPath, buf);
      localPaths.push(localPath);
      console.log(`[jobs/c1] ${jobId}: WAN output saved → ${localPath}`);
    }

    // Write generated video paths to job spec so Portal 0 can confirm the source.
    jobSpec.order = jobSpec.order || {};
    jobSpec.order.inputs = jobSpec.order.inputs || {};
    jobSpec.order.inputs.items = localPaths.map((localPath, i) => ({
      index: i,
      localPath,
      sourceType: 'wan_gen',
      prompt,
      genType,
      promptId,
      generatedAt: new Date().toISOString(),
    }));
    jobSpec.state = jobSpec.state || {};
    jobSpec.state.wanGeneration = {
      promptId,
      outputFiles: filenames,
      localPaths,
      completedAt: new Date().toISOString(),
    };

    console.log(`[jobs/c1] ${jobId}: WAN pre-generation complete — ${localPaths.length} file(s) ready for Portal 0`);
    return true;
  } catch (e) {
    logError('CPD69_WAN_GENERATION_FAIL', e, { jobId });
    return false;
  }
}

// ── Portal worker resolver ────────────────────────────────────────────────────

/**
 * Resolve extension workers for CPD-68 HeyGen add-on and future extensions.
 */
function _resolveExtensionWorkers() {
  return {
    heygen_ext: require('../portals/portal_heygen_ext'),
  };
}

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
