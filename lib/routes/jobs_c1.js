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
const { seedJobSpecFromScript, getVoiceProfile } = require('../db');
const { logError } = require('../error_logger');
const { requireAuth, requireRole, ROLES } = require('../auth');
const { resolvePreset, PRESET_IDS } = require('../presets');

// ── Validation rules per entry type ──────────────────────────────────────────

const VALID_CONTENT_TYPES = ['news', 'clips', 'sports', 'short', 'custom', 'show_commentary']; // CPD-75
const VALID_TEMPLATE_IDS = ['long-form', 'short-form'];

const baseValidations = [
  // CPD-322: entry/contentType/customerId/templateId enum + required checks
  body('entry')
    .isIn(['fetch', 'upload', 'generate', 'research'])
    .withMessage('entry must be fetch, upload, generate, or research'),
  body('contentType')
    .isIn(VALID_CONTENT_TYPES)
    .withMessage(`contentType must be one of: ${VALID_CONTENT_TYPES.join(', ')}`),
  body('customerId').isString().notEmpty().withMessage('customerId is required'),
  body('templateId')
    .optional()
    .isIn(VALID_TEMPLATE_IDS)
    .withMessage(`templateId must be one of: ${VALID_TEMPLATE_IDS.join(', ')}`),
  // CPD-322: string length bounds on free-text fields
  body('title')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 200 })
    .withMessage('title must be 200 characters or fewer'),
  body('topic')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 500 })
    .withMessage('topic must be 500 characters or fewer'),
  body('tone')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 })
    .withMessage('tone must be 100 characters or fewer'),
  // CPD-322: durationMins numeric bounds
  body('durationMins')
    .optional()
    .isInt({ min: 1, max: 120 })
    .withMessage('durationMins must be an integer between 1 and 120'),
  // CPD-322: publishMode enum
  body('publishMode')
    .optional()
    .isIn(['immediate', 'scheduled'])
    .withMessage('publishMode must be immediate or scheduled'),
  // CPD-322: platforms array — each value must be a non-empty string ≤ 50 chars
  body('platforms')
    .optional()
    .isArray({ max: 10 })
    .withMessage('platforms must be an array with at most 10 entries'),
  body('platforms.*')
    .optional()
    .isString()
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('each platform value must be a non-empty string ≤ 50 characters'),
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

// CPD-322: research entry — query length bound
const researchValidations = [
  ...baseValidations,
  body('query')
    .if(body('entry').equals('research'))
    .isString()
    .trim()
    .notEmpty()
    .isLength({ max: 2000 })
    .withMessage('query is required and must be 2000 characters or fewer'),
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
    .trim()
    .notEmpty()
    .isLength({ max: 2000 })
    .withMessage('prompt is required and must be 2000 characters or fewer'),
  body('imageId')
    .if(body('entry').equals('generate'))
    .if(body('type').equals('image'))
    .isString()
    .notEmpty()
    .withMessage('imageId is required for generate/image'),
];

// ── Dashboard format normaliser ───────────────────────────────────────────────
// The Next.js dashboard sends the "display format" (entryType, fetchSpec, etc.).
// This middleware translates it to the internal API format before validators run.
//
// Dashboard format  →  Internal format
//   entryType         →  entry  (plus: 'create' → 'generate')
//   contentType w/ suffix ('news-long') → contentType='news' + templateId='long-form'
//   fetchSpec.sourceUrls     → urls (all) + url (first, legacy compat)
//   fetchSpec.sourceLibrary  → sourceLibrary metadata for clip enrichment
//   uploadSpec.fileKeys[0]   → fileId
//   createSpec.promptText    → prompt + type='text'
//   platforms                → kept for downstream use
//   customerId absent        → req.user.id used
function normaliseDashboardPayload(req, _res, next) {
  const b = req.body;
  if (!b) return next();

  // entryType → entry
  if (b.entryType && !b.entry) {
    b.entry = b.entryType === 'create' ? 'generate' : b.entryType;
  }

  // customerId from auth if not supplied
  if (!b.customerId && req.user?.id) {
    b.customerId = req.user.id;
  }

  // brandId from X-Brand-Id header (set by resolveBrandContext if mounted)
  if (!b.brandId && req.brandId) {
    b.brandId = req.brandId;
  }

  // planTier from auth if not supplied — ensures credit discounts are applied correctly
  if (!b.planTier && req.user?.planTier) {
    b.planTier = req.user.planTier;
  }

  // Split content type suffix: 'news-long' → { contentType: 'news', templateId: 'long-form' }
  if (b.contentType && b.contentType.includes('-')) {
    const parts = b.contentType.split('-');
    const suffix = parts[parts.length - 1]; // 'long' or 'short'
    const base = parts.slice(0, -1).join('-');
    if (suffix === 'long' || suffix === 'short') {
      b.contentType = base;
      if (!b.templateId) b.templateId = suffix === 'long' ? 'long-form' : 'short-form';
    }
  }

  // fetchSpec → urls (all clips) + url (first, for legacy single-URL code paths)
  if (b.fetchSpec?.sourceUrls?.length) {
    if (!b.urls?.length) b.urls = b.fetchSpec.sourceUrls;
    if (!b.url) b.url = b.fetchSpec.sourceUrls[0];
  }
  // fetchSpec.sourceLibrary → sourceLibrary (clip metadata: title, duration, thumbnailUrl, platform)
  if (b.fetchSpec?.sourceLibrary?.length && !b.sourceLibrary) {
    b.sourceLibrary = b.fetchSpec.sourceLibrary;
  }

  // uploadSpec → fileId
  if (b.uploadSpec?.fileKeys?.[0] && !b.fileId) {
    b.fileId = b.uploadSpec.fileKeys[0];
  }

  // createSpec → prompt + type
  if (b.createSpec?.promptText && b.entry === 'generate') {
    if (!b.prompt) b.prompt = b.createSpec.promptText;
    if (!b.type) b.type = 'text';
  }

  // topic + tone — pass through to createJobSpec order context
  if (b.topic && !b.order) b.order = {};
  if (b.topic && b.order && !b.order.topic) b.order.topic = b.topic;
  if (b.tone  && b.order && !b.order.tone)  b.order.tone  = b.tone;

  // scheduledPublishAt → scheduledAt (UI field name vs. handler destructure name)
  if (b.scheduledPublishAt && !b.scheduledAt) {
    b.scheduledAt = b.scheduledPublishAt;
  }

  // scheduledStartAt is pipeline start — distinct from deferred publish
  if (b.scheduledStartAt && !b.scheduledAt) {
    // keep scheduledStartAt separate; do not map to scheduledAt (publish)
  }

  // CPD-110: wizard fields — translate formFactor + productionPath + features + addOns
  // into the backend fields the pipeline understands.
  if (b.productionPath) {
    // formFactor → templateId if not already set
    if (!b.templateId) {
      b.templateId = b.formFactor === 'short' ? 'short-form' : 'long-form';
    }

    // features array → addOns and stageMap flags
    const feats = Array.isArray(b.features) ? b.features : [];
    if (!b.addOns) b.addOns = {};

    if (feats.includes('tts')) {
      b.addOns.tts = { active: true };
    }
    if (feats.includes('commentary')) {
      b.addOns.showCommentary = { active: true };
      // show_commentary content type triggers ElevenLabs narration pipeline
      if (!b.contentType || b.contentType === 'custom') {
        b.contentType = 'show_commentary';
      }
    }
    if (feats.includes('scene_select')) {
      b.addOns.clipSourcing = { active: true };
    }
    if (feats.includes('generation')) {
      b.addOns.wan = { active: true };
      // CPD-174: dashboard toggle must set entry=generate so _runWanPreGeneration fires.
      b.entry = 'generate';
      if (!b.type) b.type = 'text';
    }
    if (feats.includes('branding')) {
      b.addOns.branding = { active: true };
    }
    if (feats.includes('burn_images')) {
      b.addOns.imageBurn = { active: true };
    }
    if (feats.includes('dynamic')) {
      b.addOns.dynamicOverlays = { active: true };
    }
    if (feats.includes('script')) {
      b.addOns.script = { active: true };
    } else {
      // Opt out of script generation — skip portal1 and exclude from credit cost
      if (!b.stageMap) b.stageMap = {};
      b.stageMap.script = { active: false };
      b.addOns.script = { active: false };
    }

    // add-on extensions (separate from addOns object — CPD-110)
    const extList = Array.isArray(b.extensions) ? b.extensions : [];
    if (extList.includes('heygen')) {
      b.addOns.heygen = { active: true };
    }
    if (extList.includes('shoppable')) {
      b.addOns.shoppable = { active: true };
    }
  }

  next();
}

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
  normaliseDashboardPayload,
  fetchValidations,
  uploadValidations,
  generateValidations,
  researchValidations,
  async (req, res) => {
    // ── Preset resolution (CPD-24) ────────────────────────────────────────────
    // If caller passes `preset`, resolve it and merge into req.body before
    // validation. Caller overrides always win over preset defaults.
    if (req.body.preset) {
      const { resolved, error } = resolvePreset(req.body.preset, req.body);
      if (error) {
        return res.status(400).json({ ok: false, error });
      }
      req.body = resolved;
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ ok: false, errors: errors.array() });
    }

    const {
      entry,
      contentType,
      customerId,
      templateId = 'long-form',
      planTier: bodyPlanTier,
      title,
      scheduledAt,
      addOns = {},
      stageMap: bodyStageMap = {},
    } = req.body;

    let sourceType;
    let sourceConfig = {};
    let stageMapOverride = {};

    if (entry === 'fetch') {
      sourceType = 'url_list';
      // Prefer b.urls (full multi-clip array from wizard) over b.url (single/legacy)
      const allUrls = req.body.urls?.length ? req.body.urls : (req.body.url ? [req.body.url] : []);
      sourceConfig = {
        urls: allUrls,
        ...(req.body.sourceLibrary?.length ? { sourceLibrary: req.body.sourceLibrary } : {}),
      };
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
    } else if (entry === 'research') {
      sourceType = 'research_query';
      sourceConfig = {
        query: req.body.query,
        depth: req.body.depth || 'standard',
        maxSources: req.body.maxSources || 5,
      };
    }

    // Merge caller-supplied stageMap overrides on top of any entry-specific defaults.
    // Caller can set e.g. { script: { active: false } } for an own-script fetch job.
    if (bodyStageMap && typeof bodyStageMap === 'object') {
      stageMapOverride = { ...stageMapOverride, ...bodyStageMap };
    }

    // Auto-populate voiceId from customer voice profile if not explicitly set in addOns.
    const resolvedAddOns = { ...addOns };
    if (!resolvedAddOns?.heygen?.voiceId && !resolvedAddOns?.tts?.voiceId) {
      try {
        const voiceProfile = await getVoiceProfile(customerId);
        if (voiceProfile?.selectedVoiceId) {
          resolvedAddOns.heygen = { ...(resolvedAddOns.heygen || {}), voiceId: voiceProfile.selectedVoiceId };
        }
      } catch (_err) {
        // Non-fatal: voice profile lookup failure should not block job creation
      }
    }

    let jobSpec;
    try {
      jobSpec = createJobSpec({
        customerId,
        brandId: req.body.brandId || null,  // CPD-328: brand context
        templateId,
        contentType,
        planTier: bodyPlanTier || null,
        sourceType,
        sourceConfig,
        title: title || `${contentType} — ${entry} — ${new Date().toISOString().slice(0, 10)}`,
        scheduledAt: scheduledAt || null,
        createdBy: 'api',
        stageMap: stageMapOverride,
        addOns: resolvedAddOns,
      });
    } catch (err) {
      logError('CPD67_JOBSPEC_CREATE_FAIL', err, { entry, contentType, customerId });
      return res.status(400).json({ ok: false, error: err.message });
    }

    const jobId = jobSpec.jobId;

    // Record the entry type on the job spec for observability.
    jobSpec.order = jobSpec.order || {};
    jobSpec.order.inputs = jobSpec.order.inputs || {};
    jobSpec.order.inputs.entry = entry;
    if (entry === 'fetch') {
      jobSpec.order.inputs.url = req.body.url;
      // Wire all source URLs for multi-clip jobs (wizard Source Library)
      if (req.body.urls?.length > 1) {
        jobSpec.order.inputs.sourceConfig = { urls: req.body.urls };
      }
      // Wire clip metadata so portals can use title/duration/thumbnail
      if (req.body.sourceLibrary?.length) {
        jobSpec.order.inputs.sourceLibrary = req.body.sourceLibrary;
      }
    }

    // Honour platform selections from the wizard (req.body.platforms overrides delivery config).
    if (Array.isArray(req.body.platforms) && req.body.platforms.length > 0) {
      jobSpec.order.publish = jobSpec.order.publish || {};
      jobSpec.order.publish.platforms = req.body.platforms;
    }

    // CPD-168: merge topic/tone/durationMins/publishMode from dashboard wizard onto jobSpec.order.
    // developer_api.js does this at lines 177-178; jobs_c1.js was missing it.
    const _topic       = req.body.topic       || req.body.order?.topic;
    const _tone        = req.body.tone        || req.body.order?.tone;
    const _durationMin = req.body.durationMins|| req.body.order?.durationMins;
    const _publishMode = req.body.publishMode || req.body.order?.publish?.publishMode;
    if (_topic)       jobSpec.order.topic                    = _topic;
    if (_tone)        jobSpec.order.tone                     = _tone;
    if (_durationMin) jobSpec.order.durationMins             = _durationMin;
    if (_publishMode) { jobSpec.order.publish = jobSpec.order.publish || {}; jobSpec.order.publish.publishMode = _publishMode; }

    // Merge per-feature configuration from the wizard into jobSpec.order.featureConfig.
    // Downstream portals (TTS, script gen, WAN, assembly) read from this namespace.
    const featureConfig = req.body.featureConfig;
    if (featureConfig && typeof featureConfig === 'object') {
      jobSpec.order.featureConfig = featureConfig;
      // Also promote TTS voiceId and speed into addOns.tts for portal_tts_ext.js compatibility
      if (featureConfig.tts?.voiceId) {
        jobSpec.addOns = jobSpec.addOns || {};
        jobSpec.addOns.tts = jobSpec.addOns.tts || {};
        jobSpec.addOns.tts.voiceId = featureConfig.tts.voiceId;
        if (featureConfig.tts.speed) jobSpec.addOns.tts.speed = parseFloat(featureConfig.tts.speed);
      }
      // Promote tone from featureConfig.script if provided (overrides top-level tone)
      if (featureConfig.script?.tone) jobSpec.order.tone = featureConfig.script.tone;
      // Promote WAN generation prompt and visual style
      if (featureConfig.generation?.prompt) {
        jobSpec.order.inputs = jobSpec.order.inputs || {};
        jobSpec.order.inputs.generationPrompt = featureConfig.generation.prompt;
        jobSpec.order.inputs.generationVisualStyle = featureConfig.generation.visualStyle || 'cinematic';
      }
    }

    if (entry === 'upload') jobSpec.order.inputs.fileId = req.body.fileId;
    if (entry === 'generate') {
      jobSpec.order.inputs.genType = req.body.type;
      jobSpec.order.inputs.prompt = req.body.prompt || null;
      jobSpec.order.inputs.imageId = req.body.imageId || null;
    }
    if (entry === 'research') {
      jobSpec.order.inputs.researchQuery = req.body.query || null;
      jobSpec.order.inputs.researchDepth = req.body.depth || 'standard';
      jobSpec.order.inputs.researchMaxSources = req.body.maxSources || 5;
    }

    // CPD-118/119: scheduled pipeline start + recurring template from wizard
    const db = require('../db');
    const scheduledStartAt = req.body.scheduledStartAt || null;
    const recurring = req.body.recurringTemplate || null;
    const hasRecurring = recurring?.recurrenceType && recurring.recurrenceType !== 'once';
    const futureStartMs = scheduledStartAt ? Date.parse(scheduledStartAt) : NaN;
    const futureStart = !isNaN(futureStartMs) && futureStartMs > Date.now() + 30 * 60 * 1000;

    if (req.body.scheduledPublishAt && _publishMode === 'scheduled') {
      jobSpec.order.publish = jobSpec.order.publish || {};
      jobSpec.order.publish.scheduledPublishAt = req.body.scheduledPublishAt;
    }

    if (futureStart && hasRecurring) {
      try {
        const tpl = await db.createTemplate(customerId, {
          name: (recurring.name || title || `Template ${jobId.slice(0, 12)}`).trim(),
          contentType: jobSpec.contentType,
          platforms: jobSpec.order?.publish?.platforms || [],
          jobSpec: _stripJobSpecForTemplate(jobSpec),
          recurrenceType: recurring.recurrenceType,
          recurrenceDay: recurring.recurrenceDay,
          recurrenceTime: recurring.recurrenceTime || new Date(futureStartMs).toISOString().slice(11, 16),
        });
        await db.updateTemplate(tpl.id, customerId, {
          next_fire_at: new Date(futureStartMs).toISOString(),
          recurrence_active: true,
        });
        return res.status(201).json({
          ok: true,
          templateId: tpl.id,
          templateOnly: true,
          status: 'scheduled_recurring',
          scheduledStartAt: new Date(futureStartMs).toISOString(),
          message: 'Recurring template saved. Production will start at the scheduled time.',
        });
      } catch (err) {
        logError('CPD119_TEMPLATE_ONLY_FAIL', err, { customerId });
        return res.status(500).json({ ok: false, error: 'Failed to save recurring template' });
      }
    }

    try {
      await db.upsertJobRow(jobId, jobSpec);
      await seedJobSpecFromScript(jobId, jobSpec);
    } catch (err) {
      logError('CPD67_DB_SEED_FAIL', err, { jobId });
      return res.status(500).json({ ok: false, error: 'Failed to persist job', detail: err.message });
    }

    let savedTemplateId = null;
    if (hasRecurring) {
      try {
        const tpl = await db.createTemplate(customerId, {
          name: (recurring.name || title || `Template ${jobId.slice(0, 12)}`).trim(),
          contentType: jobSpec.contentType,
          platforms: jobSpec.order?.publish?.platforms || [],
          jobSpec: _stripJobSpecForTemplate(jobSpec),
          recurrenceType: recurring.recurrenceType,
          recurrenceDay: recurring.recurrenceDay,
          recurrenceTime: recurring.recurrenceTime,
        });
        savedTemplateId = tpl.id;
      } catch (tplErr) {
        logError('CPD119_TEMPLATE_SAVE_FAIL', tplErr, { jobId, customerId });
      }
    }

    if (futureStart) {
      jobSpec.status = 'queued_scheduled';
      jobSpec.scheduledStartAt = new Date(futureStartMs).toISOString();
      try {
        await db.updateJobSpec(jobId, jobSpec);
        await db.updateJobScheduledStart(jobId, jobSpec.scheduledStartAt);
      } catch (err) {
        logError('CPD118_SCHEDULE_START_FAIL', err, { jobId });
        return res.status(500).json({ ok: false, error: 'Failed to schedule job start' });
      }
      const { nrJobCreated: nrCreated } = require('../nr_events');
      nrCreated(jobSpec);
      return res.status(202).json({
        ok: true,
        jobId,
        templateId: savedTemplateId,
        status: 'queued_scheduled',
        scheduledStartAt: jobSpec.scheduledStartAt,
        message: 'Job scheduled. Production starts at the selected time; credits charge then.',
      });
    }

    // Dispatch to portal pipeline via BullMQ (CPD-324).
    // Jobs are stored in Redis and survive server restarts/deploys.
    // Falls back to in-process setImmediate if REDIS_URL is not configured.
    const { nrJobCreated } = require('../nr_events');
    nrJobCreated(jobSpec);

    const _useQueue = !!process.env.REDIS_URL;
    if (_useQueue) {
      try {
        const { getPipelineQueue } = require('../queue');
        const q = getPipelineQueue();
        await q.add(jobId, { jobSpec }, { jobId });
        console.log(`[jobs/c1] ${jobId}: enqueued to BullMQ pipeline queue`);
      } catch (qErr) {
        logError('CPD324_QUEUE_ENQUEUE_FAIL', qErr, { jobId });
        // Fall through to inline fallback below
      }
    }

    if (!_useQueue) {
    // ── Inline fallback (no Redis) ───────────────────────────────────────────
    const { nrJobComplete, nrJobFailed, nrPortalStart, nrPortalPass, nrPortalFail } = require('../nr_events');
    const _jobStartMs = Date.now();
    setImmediate(async () => {
      try {
        // ── Debit credits before pipeline starts (CPD-120) ──────────────────
        const { consumeCredits } = require('../services/credits');
        const creditCost = jobSpec.creditCost || 0;
        if (creditCost > 0 && customerId) {
          const creditResult = await consumeCredits(customerId, jobId, creditCost);
          if (!creditResult.ok) {
            if (creditResult.status === 'PAUSED') {
              logError('CPD120_CREDIT_PAUSED', creditResult.reason, { jobId, customerId });
              const { saveJob } = require('../db');
              await saveJob(jobId, {
                ...jobSpec,
                status: 'credit_paused',
                updatedAt: new Date().toISOString(),
              }).catch(() => {});
              return;
            }
            if (creditResult.status !== 'ALREADY_CHARGED') {
              logError('CPD120_CREDIT_WARN', creditResult.reason || creditResult.status, { jobId, customerId });
            }
          }
        }
        // ────────────────────────────────────────────────────────────────────
        if (sourceType === 'wan_gen') {
          const preGenOk = await _runWanPreGeneration(jobSpec, jobId);
          if (!preGenOk) {
            logError('CPD69_WAN_PREGEN_FAILED', 'WAN pre-generation failed — aborting pipeline', { jobId });
            return;
          }
        }

        if (sourceType === 'research_query') {
          await _runWebResearchPreStep(jobSpec, jobId);
        }

        // CPD-172: auto-run clip sourcing when addOns.clipSourcing.active === true (scene_select toggle).
        if (jobSpec.addOns?.clipSourcing?.active) {
          try {
            const { isFeatureEnabled } = require('../services/feature_gate');
            if (isFeatureEnabled('clip.sourcing', jobSpec.planTier)) {
              const clipSourcingSvc = require('../clip_sourcing');
              await clipSourcingSvc.runForJob(jobSpec).catch((e) =>
                console.warn(`[jobs/c1] ${jobId}: clip sourcing failed (non-fatal) — ${e.message}`)
              );
            }
          } catch (_csErr) {
            console.warn(`[jobs/c1] ${jobId}: clip sourcing unavailable — ${_csErr.message}`);
          }
        }

        // CPD-169: pre-fill filledScript/scaffold before portal sequence so Portal 1
        // receives a script to approve. developer_api.js does this; jobs_c1.js was missing it.
        try {
          const { generateJobScript } = require('../script_gen_service');
          await generateJobScript(jobSpec);
        } catch (_scriptErr) {
          console.warn(`[jobs/c1] ${jobId}: script pre-gen failed (non-fatal) — ${_scriptErr.message}`);
        }

        const { runPortalSequence } = require('../portal_policy_runner');
        const workers = _resolvePortalWorkers(jobSpec);
        runPortalSequence({
          jobSpec,
          portalWorkers: workers,
          extensionWorkers: _resolveExtensionWorkers(),
          onPortalStart: (portalKey) => {
            console.log(`[jobs/c1] ${jobId}: portal ${portalKey} started`);
            nrPortalStart(jobSpec, portalKey);
          },
          onPortalPass: (portalKey, result) => {
            console.log(`[jobs/c1] ${jobId}: portal ${portalKey} passed`);
            nrPortalPass(jobSpec, portalKey, result?.score);
          },
          onPortalFail: (portalKey, result) => {
            logError('CPD67_PORTAL_FAIL', result?.reason || 'non-compliant', { jobId, portalKey });
            nrPortalFail(jobSpec, portalKey, result?.reason || result?.failReason);
          },
          onJobComplete: () => {
            console.log(`[jobs/c1] ${jobId}: pipeline complete`);
            nrJobComplete(jobSpec, Date.now() - _jobStartMs);
            // CPD-170: persist final job state (including platforms) so GET /v1/jobs/:id returns them.
            try {
              const { saveJob } = require('../db');
              saveJob(jobId, {
                ...jobSpec,
                status: 'complete',
                updatedAt: new Date().toISOString(),
              }).catch((err) => console.error('[db] onJobComplete saveJob failed:', err.message));
            } catch (_e) {}
          },
          onJobFailed: (failedPortal, result) => {
            logError('CPD67_JOB_FAILED', result?.reason || failedPortal, { jobId });
            nrJobFailed(jobSpec, failedPortal, result?.reason || result?.failReason);
          },
          persistJobStatus: ({ portalKey: pKey, policy, phase }) => {
            try {
              const { saveJob } = require('../db');
              saveJob(jobId, {
                ...jobSpec,
                status: phase,
                currentPortal: pKey,
                updatedAt: new Date().toISOString(),
              }).catch((err) => console.error('[db] persistJobStatus saveJob failed:', err.message));
            } catch (_e) {}
          },
        }); // runPortalSequence
      } catch (err) {
        logError('CPD67_DISPATCH_FAIL', err, { jobId });
      }
    });
    } // end inline fallback

    return res.status(202).json({
      ok: true,
      jobId,
      entry,
      sourceType,
      contentType,
      customerId,
      templateId: savedTemplateId,
      status: 'accepted',
      message: 'Job accepted. Pipeline is running asynchronously.',
    });
  }
);

// ── Web research pre-step (CPD-76) ──────────────────────────────────────────────

/**
 * Run web research before the portal sequence for research_query jobs.
 * Stores the research brief in jobSpec.order.inputs.researchBrief.
 * Fails gracefully — if research fails the pipeline continues without it.
 */
async function _runWebResearchPreStep(jobSpec, jobId) {
  const { runResearch } = require('../research/web_research');
  const query = jobSpec?.order?.inputs?.researchQuery;
  const depth = jobSpec?.order?.inputs?.researchDepth || 'standard';
  const maxSources = jobSpec?.order?.inputs?.researchMaxSources || 5;
  const planTier = jobSpec?.planTier || 'guided';

  if (!query) {
    console.warn(`[jobs/c1] ${jobId}: research entry but no researchQuery — skipping research step`);
    return;
  }

  console.log(`[jobs/c1] ${jobId}: running web research pre-step for "${query.slice(0, 60)}"`);
  const result = await runResearch({ query, depth, maxSources, planTier });

  if (result.skipped) {
    console.warn(`[jobs/c1] ${jobId}: web research skipped — ${result.reason}`);
  } else {
    jobSpec.order.inputs.researchBrief = result.researchBrief;
    console.log(`[jobs/c1] ${jobId}: ✅ research brief attached (${result.researchBrief.keyAngles.length} angles)`);
  }
}

// ── WAN pre-generation (CPD-69) ───────────────────────────────────────────────

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

  let generateWanVideo, pollComfyResult, downloadComfyOutput, ensurePodRunning;
  try {
    ({ generateWanVideo, pollComfyResult, downloadComfyOutput, ensurePodRunning } = require('../ai/runpod'));
  } catch (e) {
    logError('CPD69_RUNPOD_UNAVAILABLE', e, { jobId });
    return false;
  }

  try {
    const activePodId = await ensurePodRunning();
    console.log(`[jobs/c1] ${jobId}: ComfyUI pod ready — ${activePodId}`);
  } catch (e) {
    logError('CPD69_POD_START_FAILED', e, { jobId });
    return false;
  }

  try {
    console.log(`[jobs/c1] ${jobId}: starting WAN ${genType.toUpperCase()} generation`);
    // CPD-146: honour WAN_MODEL_VERSION env var or per-job featureConfig.generation.modelVersion
    const wanModelVersion = jobSpec.order?.featureConfig?.generation?.modelVersion
      || process.env.WAN_MODEL_VERSION
      || '2.2';
    const is27 = wanModelVersion === '2.7';

    const promptId = await generateWanVideo({
      positivePrompt: prompt,
      outputPrefix,
      modelVersion: wanModelVersion,
      planTier: jobSpec.planTier || 'operate',
      // WAN 2.2 / 2.1 params
      width:      is27 ? undefined : (sourceConfig.width     || 832),
      height:     is27 ? undefined : (sourceConfig.height    || 480),
      numFrames:  is27 ? undefined : (sourceConfig.numFrames || 97),
      // WAN 2.7 Partner Node params
      resolution:   is27 ? (sourceConfig.resolution  || '720P') : undefined,
      ratio:        is27 ? (sourceConfig.ratio        || '16:9') : undefined,
      durationSecs: is27 ? (sourceConfig.durationSecs || 5)     : undefined,
      promptExtend: is27 ? true                                 : undefined,
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
    tts_ext:       require('../portals/portal_tts_ext'),
    heygen_ext:    require('../portals/portal_heygen_ext'),
    shoppable_ext: require('../portals/portal_shoppable_ext'),
  };
}

/**
 * Adapt a legacy portal module (exports `run`, `canProduce`, `commit`, `prepare`)
 * to the unified worker interface expected by portal_policy_runner (`runWorker`, `isPass`).
 *
 * runWorkerAttempt is called with { workerAttempt, phase } — jobSpec must be in closure.
 */
function _adaptLegacyPortal(mod, jobSpec) {
  return {
    runWorker:       (_opts) => mod.run(jobSpec),
    runIntervention: mod.commit ? (_opts) => mod.commit(jobSpec) : null,
    isPass:          (result) => !!(result?.passed),
  };
}

function _resolvePortalWorkers(jobSpec) {
  return {
    portal0:  _adaptLegacyPortal(require('../portals/portal0'),                jobSpec),
    portal1:  _adaptLegacyPortal(require('../portals/portal1'),                jobSpec),
    portal1b: _adaptLegacyPortal(require('../portals/portal1_video_reviewer'), jobSpec),
    portal2:  _adaptLegacyPortal(require('../portals/portal2'),                jobSpec),
    portal3a: _adaptLegacyPortal(require('../portals/portal3a'),               jobSpec),
    portal3b: _adaptLegacyPortal(require('../portals/portal3b'),               jobSpec),
    portal4:  _adaptLegacyPortal(require('../portals/portal4'),                jobSpec),
    portal5:  _adaptLegacyPortal(require('../portals/portal5'),                jobSpec),
  };
}

// ── GET /presets — list available content presets (CPD-24) ───────────────────
const { getPreset } = require('../presets');
const definitions = require('../presets/definitions');

router.get('/presets', requireAuth, (req, res) => {
  const list = PRESET_IDS.map(id => ({
    id,
    description: definitions[id].description,
    entry:        definitions[id].entry,
    contentType:  definitions[id].contentType,
    templateId:   definitions[id].templateId,
  }));
  res.json({ ok: true, presets: list });
});

// ── GET /jobs — list jobs for the authenticated customer (CPD-97/98) ──────────
// Returns the 50 most recent jobs for req.user.id.
// Operators/admins with ?all=true can see all jobs.
router.get(
  '/jobs',
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    const db = require('../db');
    const userId = req.user.id;
    const isOperator = req.user.role === 'superadmin';
    const allJobs    = isOperator && req.query.all === 'true';
    // Operators/admins may scope to a single customer via ?customerId=
    const scopedCustomerId = allJobs && req.query.customerId ? req.query.customerId : null;

    try {
      const rows = allJobs
        ? (scopedCustomerId
            ? await db.listJobsByCustomer(scopedCustomerId, 100)
            : await db.listAllJobRows(100))
        : await db.listJobsByCustomer(userId, 50);

      const shapeRow = (row, customerName) => {
        const spec = row.job_spec
          ? (typeof row.job_spec === 'string' ? JSON.parse(row.job_spec) : row.job_spec)
          : {};
        const rowStatus = row.status || spec.status || 'queued';
        const scheduledStartAt = row.scheduled_start_at
          ? new Date(row.scheduled_start_at).toISOString()
          : (spec.scheduledStartAt || null);
        return {
          jobId:               row.id,
          contentType:         spec.contentType || null,
          entryType:           spec.order?.inputs?.entryType || spec.sourceType || null,
          status:              rowStatus,
          customerId:          row.customer_id,
          customerName:        customerName || null,
          planTier:            spec.planTier || 'operate',
          publishMode:         spec.order?.publish?.publishMode || 'immediate',
          scheduledPublishAt:  spec.order?.publish?.scheduledPublishAt || null,
          scheduledStartAt,
          createdAt:           row.created_at ? new Date(Number(row.created_at)).toISOString() : null,
          updatedAt:           row.updated_at ? new Date(Number(row.updated_at)).toISOString() : null,
          platforms:           spec.order?.publish?.platforms || spec.deliverySpec?.platforms || [],
          portalReports:       _buildPortalReports(spec),
          outputUrl:           spec.state?.savedOutputs?.r2VideoUrl || spec.state?.savedOutputs?.driveUrl || null,
          thumbnailUrl:        spec.state?.savedOutputs?.thumbnail?.r2Url || spec.state?.savedOutputs?.thumbnailDriveUrl || null,
          publishCopy:         spec.state?.savedOutputs?.publishCopy || null,
          filledScript:        spec.filledScript || spec.scaffold || null,
          wizardConfig:        _buildWizardConfig(spec),
        };
      };

      let jobs;
      if (allJobs) {
        // Enrich with customer names from Clerk (deduplicated batch lookup)
        const { createClerkClient } = require('@clerk/express');
        const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
        const uniqueIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))];
        const nameMap = {};
        await Promise.all(uniqueIds.map(async (uid) => {
          try {
            const cu = await clerk.users.getUser(uid);
            const fn = cu.firstName?.trim();
            const ln = cu.lastName?.trim();
            const email = cu.emailAddresses?.[0]?.emailAddress;
            nameMap[uid] = [fn, ln].filter(Boolean).join(' ') || email || uid;
          } catch { nameMap[uid] = null; }
        }));
        jobs = rows.map((row) => shapeRow(row, nameMap[row.customer_id]));
      } else {
        jobs = rows.map((row) => shapeRow(row, null));
      }

      res.json({ ok: true, jobs });
    } catch (err) {
      logError('GET_JOBS_C1_FAIL', err, { userId });
      res.status(500).json({ ok: false, error: 'Failed to load jobs' });
    }
  }
);

// ── GET /jobs/:jobId — single job detail with portal progress (CPD-98) ────────
router.get(
  '/jobs/:jobId',
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    const db = require('../db');
    const { jobId } = req.params;
    const userId = req.user.id;
    const isOperator = req.user.role === 'superadmin';

    try {
      const row = await db.loadJobRow(jobId);

      if (!row) return res.status(404).json({ ok: false, error: 'Job not found' });

      // Customers can only see their own jobs; operators can see all
      if (!isOperator && row.customer_id !== userId) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
      }

      const spec = row.job_spec
        ? (typeof row.job_spec === 'string' ? JSON.parse(row.job_spec) : row.job_spec)
        : {};

      // Fetch publish results for completed jobs (fire-and-forget fallback to [])
      let publishResults = [];
      if (spec.status === 'complete' || spec.status === 'published') {
        try { publishResults = await db.getPublishResults(row.id); } catch (_e) { /* non-fatal */ }
      }

      res.json({
        ok: true,
        job: {
          jobId:               row.id,
          contentType:         spec.contentType || null,
          entryType:           spec.order?.inputs?.entryType || spec.sourceType || null,
          status:              row.status || spec.status || 'queued',
          customerId:          row.customer_id,
          planTier:            spec.planTier || 'operate',
          publishMode:         spec.order?.publish?.publishMode || 'immediate',
          scheduledPublishAt:  spec.order?.publish?.scheduledPublishAt || null,
          scheduledStartAt:    row.scheduled_start_at
            ? new Date(row.scheduled_start_at).toISOString()
            : (spec.scheduledStartAt || null),
          createdAt:           row.created_at ? new Date(Number(row.created_at)).toISOString() : null,
          updatedAt:           row.updated_at ? new Date(Number(row.updated_at)).toISOString() : null,
          platforms:           spec.order?.publish?.platforms || spec.deliverySpec?.platforms || [],
          portalReports:       _buildPortalReports(spec),
          outputUrl:           spec.state?.savedOutputs?.r2VideoUrl || spec.state?.savedOutputs?.driveUrl || null,
          thumbnailUrl:        spec.state?.savedOutputs?.thumbnail?.r2Url || spec.state?.savedOutputs?.thumbnailDriveUrl || null,
          publishCopy:         spec.state?.savedOutputs?.publishCopy || null,
          filledScript:        spec.filledScript || spec.scaffold || null,
          wizardConfig:        _buildWizardConfig(spec),
          publishResults,
        },
      });
    } catch (err) {
      logError('GET_JOB_C1_FAIL', err, { jobId, userId });
      res.status(500).json({ ok: false, error: 'Failed to load job' });
    }
  }
);

// ── GET /jobs/:jobId/staging-assets — presigned URLs + spec for review ────────
router.get(
  '/jobs/:jobId/staging-assets',
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    const db = require('../db');
    const { jobId } = req.params;
    const userId    = req.user.id;
    const isOp      = req.user.role === 'superadmin';

    try {
      const row = await db.loadJobRow(jobId);
      if (!row) return res.status(404).json({ ok: false, error: 'Job not found' });
      if (!isOp && row.customer_id !== userId) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
      }

      const spec = row.job_spec
        ? (typeof row.job_spec === 'string' ? JSON.parse(row.job_spec) : row.job_spec)
        : {};

      const { getPresignedDownloadUrl } = require('../storage');
      const rawVideoUrl     = spec.state?.savedOutputs?.r2VideoUrl || null;
      const rawThumbnailUrl = spec.state?.savedOutputs?.thumbnail?.r2Url || null;

      let videoPresigned     = null;
      let thumbnailPresigned = null;

      try {
        if (rawVideoUrl)     videoPresigned     = await getPresignedDownloadUrl(rawVideoUrl,     3600);
        if (rawThumbnailUrl) thumbnailPresigned = await getPresignedDownloadUrl(rawThumbnailUrl, 3600);
      } catch (_presignErr) {
        videoPresigned     = rawVideoUrl;
        thumbnailPresigned = rawThumbnailUrl;
      }

      const scriptText =
        spec.state?.script?.finalScript ||
        spec.state?.script?.correctedScript ||
        spec.state?.script?.rawScript ||
        null;

      const portalReports = _buildPortalReports(spec).map((r) => ({
        ...r,
        violations: r.violations || [],
        notes:      r.notes || null,
      }));

      res.json({
        ok: true,
        jobId:   row.id,
        status:  spec.status || 'queued',
        staging: spec.staging || false,
        input: {
          contentType: spec.contentType   || null,
          sourceType:  spec.sourceType    || null,
          tone:        spec.order?.tone   || null,
          topic:       spec.order?.topic  || spec.order?.userPrompt || null,
          duration:    spec.order?.duration || null,
          platforms:   spec.order?.publish?.platforms || [],
          planTier:    spec.planTier      || null,
          wizardConfig: spec.wizardConfig || null,
          submittedAt: row.created_at ? new Date(Number(row.created_at)).toISOString() : null,
        },
        output: {
          videoUrl:     videoPresigned,
          thumbnailUrl: thumbnailPresigned,
          script:       scriptText,
          publishCopy:  spec.state?.savedOutputs?.publishCopy || spec.state?.publishCopy || null,
          savedOutputs: spec.state?.savedOutputs || null,
        },
        portalReports,
        urlExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      });
    } catch (err) {
      logError('GET_STAGING_ASSETS_FAIL', err, { jobId, userId });
      res.status(500).json({ ok: false, error: 'Failed to load staging assets' });
    }
  }
);

// ── POST /jobs/:jobId/approve-publish — approve staged output for publish ──────
router.post(
  '/jobs/:jobId/approve-publish',
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    const db     = require('../db');
    const { jobId } = req.params;
    const userId = req.user.id;
    const isOp   = req.user.role === 'superadmin';

    try {
      const row = await db.loadJobRow(jobId);
      if (!row) return res.status(404).json({ ok: false, error: 'Job not found' });
      if (!isOp && row.customer_id !== userId) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
      }

      const spec = row.job_spec
        ? (typeof row.job_spec === 'string' ? JSON.parse(row.job_spec) : row.job_spec)
        : {};

      const videoUrl = spec.state?.savedOutputs?.r2VideoUrl || null;
      if (!videoUrl) {
        return res.status(422).json({ ok: false, error: 'no_output', message: 'No video output available to publish.' });
      }

      const { getPresignedDownloadUrl } = require('../storage');
      let signedUrl;
      try {
        signedUrl = await getPresignedDownloadUrl(videoUrl, 7200);
      } catch { signedUrl = videoUrl; }

      if (!spec.state) spec.state = {};
      if (!spec.state.savedOutputs) spec.state.savedOutputs = {};
      spec.state.savedOutputs.r2VideoUrl = signedUrl;

      const { retryPlatformUpload, resolveUploadPostProfile } = require('../portals/portal5');
      const platforms = req.body.platforms || spec.order?.publish?.platforms || [];
      const profile   = resolveUploadPostProfile(spec);

      if (!profile) {
        return res.status(422).json({
          ok: false,
          error: 'no_upload_post_profile',
          message: 'No upload-post profile configured. Set publishConfig.uploadPostProfile on the job spec or UPLOADPOST_PROFILE env var.',
        });
      }

      const results = {};
      for (const platform of platforms) {
        try {
          results[platform] = await retryPlatformUpload(spec, platform);
        } catch (pErr) {
          results[platform] = { failed: true, error: pErr.message };
        }
      }

      spec.staging    = false;
      spec.status     = 'published';
      spec.approvedAt = new Date().toISOString();
      spec.publishResults = results;
      await db.updateJobSpec(row.id, spec);

      res.json({ ok: true, jobId: row.id, approved: true, platforms: results });
    } catch (err) {
      logError('APPROVE_PUBLISH_FAIL', err, { jobId, userId });
      res.status(500).json({ ok: false, error: 'approve_publish_failed', message: err.message });
    }
  }
);

/**
 * Build a portal progress array from job spec gate results.
 * @param {Object} spec
 * @returns {Array}
 */
function _buildPortalReports(spec) {
  // portalReports is the authoritative source — written by each portal worker as it completes.
  // state.gateResults is legacy/unused and is always empty; do not read from it.
  const reports = spec?.portalReports || {};
  const PORTALS = ['portal0', 'portal1', 'portal1b', 'portal2', 'portal3a', 'portal3b', 'portal4', 'portal5'];
  return PORTALS.map((key) => {
    const r = reports[key];
    if (!r) {
      const active = spec?.portals?.[key]?.active;
      return { portal: key, status: active ? 'pending' : 'skipped', passed: false };
    }
    const passed = r.passed === true;
    const status = passed ? 'pass'
      : r.outcome === 'mismatch_fixable' ? 'hold'
      : r.failReason ? 'failed'
      : r.completedAt ? 'pass'
      : 'pending';
    return {
      portal:    key,
      status,
      passed,
      score:     r.score ?? undefined,
      outcome:   r.outcome ?? undefined,
      notes:     r.notes ?? undefined,
      failReason: r.failReason ?? undefined,
    };
  });
}

/**
 * Extract human-readable wizard configuration from a job spec (CPD-112).
 * Used by the History page "what you selected" review card.
 */
function _buildWizardConfig(spec) {
  const formFactor = spec?.order?.output?.formFactor ||
    (spec?.templateId === 'short-form' ? 'short' : 'long');

  const addOns = spec?.addOns || {};
  const activeAddOns = Object.entries(addOns)
    .filter(([, v]) => v?.active)
    .map(([k]) => k);

  // Summarise featureConfig keys that are non-empty objects
  const featureConfig = spec?.featureConfig || {};
  const activeFeatures = Object.entries(featureConfig)
    .filter(([, v]) => v && typeof v === 'object' && Object.keys(v).length > 0)
    .map(([k]) => k);

  return {
    formFactor,
    templateId:    spec?.templateId || null,
    contentType:   spec?.contentType || null,
    entryType:     spec?.order?.inputs?.entryType || spec?.sourceType || null,
    addOns:        activeAddOns,
    platforms:     spec?.order?.publish?.platforms || spec?.deliverySpec?.platforms || [],
    publishMode:   spec?.order?.publish?.publishMode || 'immediate',
    scheduledAt:   spec?.order?.publish?.scheduledPublishAt || null,
    productionPath: spec?.productionPath || null,
    // Extended spec fields for job spec card
    topic:         spec?.order?.meta?.topic || spec?.topic || null,
    tone:          spec?.order?.meta?.tone  || spec?.tone  || null,
    durationMins:  spec?.order?.output?.durationMins || spec?.durationMins || null,
    planTier:      spec?.planTier || null,
    creditCost:    spec?.creditCost || null,
    activeFeatures,
  };
}

// ── Operator job actions (CPD-104) ────────────────────────────────────────────

const OPERATOR_PORTALS = ['portal0', 'portal1', 'portal1b', 'portal2', 'portal3a', 'portal3b', 'portal4', 'portal5'];

/**
 * POST /jobs/:jobId/retry
 * Operator-only. Resets a failed/held job back to queued and re-dispatches
 * the full portal pipeline from the beginning.
 */
router.post(
  '/jobs/:jobId/retry',
  requireAuth,
  requireRole({ minLevel: ROLES.SUPERADMIN }),
  async (req, res) => {
    const db = require('../db');
    const { jobId } = req.params;
    const operatorId = req.user.id;

    try {
      const row = await db.loadJobRow(jobId);
      if (!row) return res.status(404).json({ ok: false, error: 'Job not found' });

      const spec = row.job_spec
        ? (typeof row.job_spec === 'string' ? JSON.parse(row.job_spec) : row.job_spec)
        : {};

      const currentStatus = spec.status || 'queued';
      if (!['failed', 'held', 'complete'].includes(currentStatus)) {
        return res.status(409).json({ ok: false, error: `Cannot retry a job with status: ${currentStatus}` });
      }

      spec.status = 'queued';
      spec.updatedAt = new Date().toISOString();
      if (!spec.state) spec.state = {};
      spec.state.gateResults = {};
      spec.state.operatorActions = [
        ...(spec.state.operatorActions || []),
        { action: 'retry', operatorId, at: spec.updatedAt },
      ];

      await db.updateJobSpec(jobId, spec);

      const { runPortalSequence } = require('../portal_policy_runner');
      const workers = _resolvePortalWorkers(spec);
      setImmediate(() => {
        runPortalSequence({
          jobSpec: spec,
          portalWorkers: workers,
          extensionWorkers: _resolveExtensionWorkers(),
          onPortalFail: (pk, r) => { logError('CPD104_RETRY_PORTAL_FAIL', r?.reason || pk, { jobId }); nrPortalFail(spec, pk, r?.reason || r?.failReason); },
          onJobFailed: (fp, r) => { logError('CPD104_RETRY_JOB_FAILED', r?.reason || fp, { jobId }); nrJobFailed(spec, fp, r?.reason || r?.failReason); },
          persistJobStatus: ({ portalKey: pKey, phase }) => {
            try {
              const { saveJob } = require('../db');
              saveJob(jobId, { ...spec, status: phase, currentPortal: pKey, updatedAt: new Date().toISOString() })
                .catch((err) => console.error('[db] retry persistJobStatus failed:', err.message));
            } catch (_e) {}
          },
        });
      });

      res.json({ ok: true, jobId, action: 'retry', previousStatus: currentStatus });
    } catch (err) {
      logError('CPD104_RETRY_FAIL', err, { jobId, operatorId });
      res.status(500).json({ ok: false, error: 'Failed to retry job' });
    }
  }
);

/**
 * POST /jobs/:jobId/advance
 * Operator-only. Force-advances a held/failed job past the current blocked portal.
 * Marks the blocked portal as force-passed and re-dispatches from the next portal.
 */
router.post(
  '/jobs/:jobId/advance',
  requireAuth,
  requireRole({ minLevel: ROLES.SUPERADMIN }),
  async (req, res) => {
    const db = require('../db');
    const { jobId } = req.params;
    const operatorId = req.user.id;

    try {
      const row = await db.loadJobRow(jobId);
      if (!row) return res.status(404).json({ ok: false, error: 'Job not found' });

      const spec = row.job_spec
        ? (typeof row.job_spec === 'string' ? JSON.parse(row.job_spec) : row.job_spec)
        : {};

      const currentStatus = spec.status || 'queued';
      if (!['failed', 'held', 'running'].includes(currentStatus)) {
        return res.status(409).json({ ok: false, error: `Cannot advance a job with status: ${currentStatus}` });
      }

      // Find the first blocked or failed portal
      const gateResults = spec.state?.gateResults || {};
      const blockedPortal = OPERATOR_PORTALS.find((pk) => {
        const r = gateResults[pk];
        if (!r) return false;
        const passed = r.passed === true || r.policy?.status === 'passed';
        return !passed;
      });

      if (!blockedPortal) {
        return res.status(409).json({ ok: false, error: 'No blocked portal found to advance past' });
      }

      const now = new Date().toISOString();
      if (!spec.state) spec.state = {};
      if (!spec.state.gateResults) spec.state.gateResults = {};

      spec.state.gateResults[blockedPortal] = {
        passed:        true,
        policy:        { status: 'passed' },
        notes:         ['Force-advanced by operator'],
        forceAdvanced: true,
        forceAdvancedAt: now,
        forceAdvancedBy: operatorId,
      };
      spec.status = 'queued';
      spec.updatedAt = now;
      spec.state.operatorActions = [
        ...(spec.state.operatorActions || []),
        { action: 'advance', portal: blockedPortal, operatorId, at: now },
      ];

      await db.updateJobSpec(jobId, spec);

      const { runPortalSequence } = require('../portal_policy_runner');
      const workers = _resolvePortalWorkers(spec);
      setImmediate(() => {
        runPortalSequence({
          jobSpec: spec,
          portalWorkers: workers,
          extensionWorkers: _resolveExtensionWorkers(),
          onPortalFail: (pk, r) => { logError('CPD104_ADVANCE_PORTAL_FAIL', r?.reason || pk, { jobId }); nrPortalFail(spec, pk, r?.reason || r?.failReason); },
          onJobFailed: (fp, r) => { logError('CPD104_ADVANCE_JOB_FAILED', r?.reason || fp, { jobId }); nrJobFailed(spec, fp, r?.reason || r?.failReason); },
          persistJobStatus: ({ portalKey: pKey, phase }) => {
            try {
              const { saveJob } = require('../db');
              saveJob(jobId, { ...spec, status: phase, currentPortal: pKey, updatedAt: new Date().toISOString() })
                .catch((err) => console.error('[db] advance persistJobStatus failed:', err.message));
            } catch (_e) {}
          },
        });
      });

      res.json({ ok: true, jobId, action: 'advance', advancedPortal: blockedPortal });
    } catch (err) {
      logError('CPD104_ADVANCE_FAIL', err, { jobId, operatorId });
      res.status(500).json({ ok: false, error: 'Failed to advance job' });
    }
  }
);

/**
 * POST /jobs/:jobId/rollback
 * Operator-only. Resets a job fully — clears all gate results and status,
 * returning it to an initial queued state without re-dispatching.
 * Operator manually re-submits when ready.
 */
router.post(
  '/jobs/:jobId/rollback',
  requireAuth,
  requireRole({ minLevel: ROLES.SUPERADMIN }),
  async (req, res) => {
    const db = require('../db');
    const { jobId } = req.params;
    const operatorId = req.user.id;

    try {
      const row = await db.loadJobRow(jobId);
      if (!row) return res.status(404).json({ ok: false, error: 'Job not found' });

      const spec = row.job_spec
        ? (typeof row.job_spec === 'string' ? JSON.parse(row.job_spec) : row.job_spec)
        : {};

      const previousStatus = spec.status || 'queued';
      const now = new Date().toISOString();

      spec.status = 'held';
      spec.updatedAt = now;
      if (!spec.state) spec.state = {};
      spec.state.gateResults = {};
      spec.state.operatorActions = [
        ...(spec.state.operatorActions || []),
        { action: 'rollback', previousStatus, operatorId, at: now },
      ];

      await db.updateJobSpec(jobId, spec);

      res.json({ ok: true, jobId, action: 'rollback', previousStatus });
    } catch (err) {
      logError('CPD104_ROLLBACK_FAIL', err, { jobId, operatorId });
      res.status(500).json({ ok: false, error: 'Failed to rollback job' });
    }
  }
);

// ── GET /admin/customers ───────────────────────────────────────────────────────
// Admin-only. Returns all Clerk users enriched with their job counts from PG.
// Used by the superuser customers view in the dashboard.
router.get(
  '/admin/customers',
  requireAuth,
  requireRole({ minLevel: ROLES.SUPERADMIN }),
  async (req, res) => {
    try {
      const axios = require('axios');
      const db    = require('../db');

      const clerkKey = process.env.CLERK_SECRET_KEY;
      if (!clerkKey) return res.status(503).json({ ok: false, error: 'Clerk not configured' });

      // Fetch all users from Clerk (up to 500 — paginate if ever needed)
      const { data: clerkUsers } = await axios.get(
        'https://api.clerk.com/v1/users?limit=100&order_by=-created_at',
        { headers: { Authorization: `Bearer ${clerkKey}` }, timeout: 10000 }
      );

      // Fetch job counts per customer from PG
      let jobCounts = {};
      try {
        const { rows } = await db.query(
          `SELECT customer_id, COUNT(*) AS cnt,
                  MAX(created_at) AS last_job_at
           FROM jobs GROUP BY customer_id`
        );
        for (const r of rows) {
          jobCounts[r.customer_id] = { count: parseInt(r.cnt, 10), lastJobAt: r.last_job_at };
        }
      } catch (_) { /* non-fatal — PG may not be ready */ }

      const customers = (clerkUsers || []).map((u) => {
        const meta     = u.public_metadata || {};
        const email    = (u.email_addresses || [])[0]?.email_address || null;
        const jobData  = jobCounts[u.id] || { count: 0, lastJobAt: null };
        return {
          id:         u.id,
          email,
          firstName:  u.first_name || null,
          lastName:   u.last_name  || null,
          role:       meta.role       || 'customer',
          planTier:   meta.planTier   || 'operate',
          credits:    meta.credits    ?? null,
          createdAt:  u.created_at    ? new Date(u.created_at).toISOString() : null,
          jobCount:   jobData.count,
          lastJobAt:  jobData.lastJobAt,
        };
      });

      res.json({ ok: true, customers });
    } catch (err) {
      logError('ADMIN_CUSTOMERS_FAIL', err, {});
      res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ── PUT /jobs/:jobId/schedule — publish + pipeline start schedule (CPD-48 / CPD-118) ──
router.put(
  '/jobs/:jobId/schedule',
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  apiLimit,
  async (req, res) => {
    const db = require('../db');
    const { jobId } = req.params;
    const userId = req.user.id;
    const isOperator = req.user.role === 'superadmin';
    const { publishMode, scheduledPublishAt, scheduledStartAt } = req.body;

    try {
      const row = await db.loadJobRow(jobId);
      if (!row) return res.status(404).json({ error: 'Job not found' });
      if (!isOperator && row.customer_id !== userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      if (publishMode === 'scheduled') {
        if (!scheduledPublishAt) {
          return res.status(400).json({ error: 'scheduledPublishAt required when publishMode is "scheduled"' });
        }
        const ts = Date.parse(scheduledPublishAt);
        if (isNaN(ts)) return res.status(400).json({ error: 'scheduledPublishAt must be a valid ISO date' });
        if (ts < Date.now() + 30 * 60 * 1000) {
          return res.status(400).json({ error: 'scheduledPublishAt must be at least 30 minutes in the future' });
        }
        await db.updateJobPublishSchedule(jobId, 'scheduled', ts);
      } else if (publishMode === 'immediate') {
        await db.updateJobPublishSchedule(jobId, 'immediate', null);
      }

      if (scheduledStartAt !== undefined) {
        if (scheduledStartAt === null) {
          await db.updateJobScheduledStart(jobId, null);
        } else {
          const ts = Date.parse(scheduledStartAt);
          if (isNaN(ts)) return res.status(400).json({ error: 'scheduledStartAt must be a valid ISO date' });
          if (ts < Date.now()) return res.status(400).json({ error: 'scheduledStartAt must be in the future' });
          await db.updateJobScheduledStart(jobId, new Date(ts).toISOString());
        }
      }

      res.json({
        ok: true,
        jobId,
        publishMode: publishMode || 'immediate',
        scheduledPublishAt: scheduledPublishAt || null,
        scheduledStartAt: scheduledStartAt ?? undefined,
      });
    } catch (err) {
      logError('PUT_JOB_SCHEDULE_FAIL', err, { jobId });
      res.status(500).json({ error: err.message });
    }
  },
);

function _stripJobSpecForTemplate(spec) {
  const strip = ['jobId', 'customerId', 'status', 'createdAt', 'updatedAt', 'completedAt',
    'state', 'portalReports', 'outputUrl', 'thumbnailUrl', 'publishResults',
    'failureReason', 'creditLedgerId', 'assembledPath', 'scheduledStartAt'];
  const out = JSON.parse(JSON.stringify(spec));
  for (const k of strip) delete out[k];
  return out;
}

module.exports = router;
module.exports._runWanPreGeneration    = _runWanPreGeneration;
module.exports._runWebResearchPreStep  = _runWebResearchPreStep;
module.exports._resolvePortalWorkers   = _resolvePortalWorkers;
module.exports._resolveExtensionWorkers = _resolveExtensionWorkers;
