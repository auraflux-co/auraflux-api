'use strict';
/**
 * lib/routes/developer_api.js — CPD-126: Developer API for Operate plan customers
 *
 * Mounted at /v1/ in server.js.
 * Auth: Authorization: Bearer af_live_<key>  (lib/auth/api_key.js)
 *
 * Job submission (POST /v1/jobs):
 *   entry               — 'compose' | 'fetch' | 'upload' | 'generate' (default fetch)
 *   productionProfile   — 'broadcast_desk' | 'vertical_reel' | 'live_event' (preferred over legacy contentType)
 *   format              — 'short' | 'long' → template short-form vs long-form
 * Legacy clients may still send contentType (news/clips/sports); profile is inferred for responses.
 *
 * Endpoints:
 *   POST   /v1/jobs                    — submit a job
 *   GET    /v1/jobs                    — list jobs
 *   GET    /v1/jobs/:id               — get job status
 *   GET    /v1/jobs/:id/result        — get output/delivery
 *   DELETE /v1/jobs/:id               — cancel a job
 *   GET    /v1/feature-inputs          — feature input schema (what each addOn requires)
 *   GET    /v1/templates              — list templates
 *   POST   /v1/templates              — create template
 *   GET    /v1/templates/:id          — get template
 *   DELETE /v1/templates/:id          — delete template
 *   GET    /v1/schedule               — list upcoming scheduled jobs
 *   PATCH  /v1/jobs/:id/schedule      — set/update scheduled publish time
 *   POST   /v1/upload                 — get presigned R2 upload URL
 *   GET    /v1/jobs/:id/staging-assets — presigned video+thumbnail URLs + spec for review
 *   POST   /v1/jobs/:id/approve-publish — approve staged output for upload-post publish
 *   GET    /v1/account                — credits, plan tier, rate limits
 *   GET    /v1/account/api-keys       — list API keys
 *   POST   /v1/account/api-keys       — create API key
 *   DELETE /v1/account/api-keys/:keyId — revoke API key
 */

const express   = require('express');
const { requireApiKeyOrE2EAuth } = require('../auth/api_key');
const { createNotification }   = require('../services/notifications');
const { createJobSpec }      = require('../job_spec');
const { calculateCreditCost } = require('../services/credit_calculator');
const { consumeCredits } = require('../services/credits');
const { getCreditBalance } = require('../db');
const { createApiKey, listApiKeys, revokeApiKey } = require('../services/api_keys');
const { isFeatureEnabled }   = require('../services/feature_gate');
const { logError }           = require('../error_logger');
const { getPublicSchema, validateFeatureInputs, extractFeatureConfig } = require('../services/feature_input_schema');
const db                     = require('../db/postgres');
const { ensureOwnerMembership } = require('../services/account_members');

const router = express.Router();

// Routing logic lives in lib/pipeline_routing.js — single source of truth.
// Changing routing? Edit that file. The pre-commit hook will validate all known paths.
const {
  resolveProductionProfileAndContentType,
  resolveTemplateIdFromBody,
} = require('../pipeline_routing');

// CPD-485: shared post-portal hooks — assembly, TTS mix, chrome, grading.
const {
  runAssemblyAndPostProcess,
  isPortal1Active,
  runTtsMixAndChrome,
  ensureChromeApplied,
  runJobComplete,
} = require('../services/pipeline_assembly');

// All /v1/ routes require API key auth
router.use(requireApiKeyOrE2EAuth);

// ─── Feature gate: api.developer_access ───────────────────────────────────────
router.use((req, res, next) => {
  if (!isFeatureEnabled('api.developer_access', req.user.planTier)) {
    return res.status(403).json({
      error: 'plan_not_supported',
      message: 'Developer API access requires the Operate plan or higher.',
    });
  }
  next();
});

// ─── POST /v1/jobs ─────────────────────────────────────────────────────────────
router.post('/jobs', async (req, res) => {
  const customerId = req.user.id;
  const planTier   = req.user.planTier;
  let   b          = req.body || {};

  // Lazy-seed the account_members owner row so this customer appears in the admin CRM.
  // API-key submissions bypass resolveAccountContext (Clerk auth), so API-only customers
  // never get an owner row and are invisible to GET /admin/crm without this.
  ensureOwnerMembership(customerId, req.user.email).catch(() => {});

  // fromTemplateId: load a saved template and merge its job_spec as the base for
  // this submission. Request body values (urls, topic, tone, platform overrides)
  // take precedence so each run still uses fresh source media.
  if (b.fromTemplateId) {
    try {
      const savedTpl = await db.getTemplate(b.fromTemplateId, customerId);
      if (!savedTpl) {
        return res.status(404).json({ error: 'template_not_found', message: `Template ${b.fromTemplateId} not found` });
      }
      const tplSpec = typeof savedTpl.job_spec === 'string'
        ? JSON.parse(savedTpl.job_spec)
        : (savedTpl.job_spec || savedTpl.jobSpec || {});
      // Merge: template is base, request overrides specific fields
      b = {
        contentType:    tplSpec.contentType    || tplSpec.order?.contentType,
        profile:        tplSpec.productionProfile,
        format:         tplSpec.templateId === 'short-form' ? 'short' : 'long',
        durationMins:   tplSpec.durationMins   || tplSpec.order?.output?.durationMins,
        platform:       tplSpec.order?.publish?.platforms?.[0],
        publishMode:    tplSpec.order?.publish?.publishMode || 'immediate',
        addOns:         tplSpec.addOns         || {},
        topic:          tplSpec.order?.meta?.topic || tplSpec.topic,
        tone:           tplSpec.order?.meta?.tone  || tplSpec.tone,
        ...b,  // request body fields override template values
        _fromTemplateId:   b.fromTemplateId,
        _fromTemplateName: savedTpl.name || null,
      };
      delete b.fromTemplateId;
    } catch (tplErr) {
      return res.status(500).json({ error: 'template_load_failed', message: tplErr.message });
    }
  }

  try {
    const { productionProfile, contentType: resolvedContentType } = resolveProductionProfileAndContentType(b);
    const resolvedTemplateId = resolveTemplateIdFromBody(b, resolvedContentType);

    // Map entry → sourceType + sourceConfig (mirrors jobs_c1.js logic)
    // compose = topic/script-led job with no source media yet (Operate path uses script_gen + portals; no WAN pre-step here).
    const entry = b.entry || 'fetch';
    let sourceType;
    let sourceConfig = {};
    let stageMapOverride = b.stageMap || {};

    if (entry === 'compose') {
      sourceType   = 'none';
      sourceConfig = {};
    } else if (entry === 'fetch') {
      sourceType   = 'url_list';
      // CPD-180: prefer b.urls (multi-clip array for COMPACT stitch) over b.url (single)
      sourceConfig = b.sourceConfig || (b.urls?.length ? { urls: b.urls } : (b.url ? { urls: [b.url] } : {}));
    } else if (entry === 'upload') {
      sourceType       = 'upload';
      sourceConfig     = { uploadSessionId: b.fileId };
      stageMapOverride = {
        script: { active: false, provider: null, approvalMode: 'auto', skippedReason: 'upload_entry_own_script' },
        ...stageMapOverride,
      };
    } else if (entry === 'generate') {
      sourceType   = 'wan_gen';
      sourceConfig = b.type === 'image'
        ? { imageId: b.imageId, genType: 'image' }
        : { prompt: b.prompt || b.topic || (b.order && b.order.topic), genType: 'text' };
    } else {
      sourceType   = b.sourceType || 'url_list';
      sourceConfig = b.sourceConfig || {};
    }

    // CPD-505: normalise publish metadata — accept either b.publishMeta (wizard shape)
    // or the b.order.publish.* REST shape so the developer API has full parity with jobs_c1.
    const _apiPublishMeta = (() => {
      const pm = { ...(b.publishMeta || {}) };
      const op = b.order?.publish || {};
      if (!pm.title       && op.title)       pm.title        = op.title;
      if (!pm.description && op.description) pm.description  = op.description;
      if (!pm.tags        && op.tags)        pm.tags         = op.tags;
      if (!pm.privacyStatus && (op.privacyStatus || op.privacy))
        pm.privacyStatus = op.privacyStatus || op.privacy;
      if (!pm.tiktokCaption    && op.tiktokCaption)    pm.tiktokCaption    = op.tiktokCaption;
      if (!pm.instagramCaption && op.instagramCaption) pm.instagramCaption = op.instagramCaption;
      return Object.keys(pm).length ? pm : {};
    })();

    const jobSpec = createJobSpec({
      customerId,
      planTier,
      templateId:      resolvedTemplateId,
      contentType:     resolvedContentType,
      sourceType,
      sourceConfig,
      stageMap:        stageMapOverride,
      addOns:          b.addOns       || {},
      durationMins:    b.durationMins || (b.order?.duration ? parseInt(b.order.duration, 10) / 60 : 5),
      publishMeta:     _apiPublishMeta,
      productionProfile,  // CPD-872 fix: bake into requiredFeatures at creation time
    });

    jobSpec.productionProfile = productionProfile;
    if (b._fromTemplateId)   jobSpec.fromTemplateId = b._fromTemplateId;
    if (b._fromTemplateName) jobSpec.templateName   = b._fromTemplateName;

    // Detect and store source platform so chrome overlay uses brand colors.
    // job_spec.js may have already detected it from sourceConfig.urls at createJobSpec time;
    // this re-checks using all available URL fields and re-freezes chrome if the platform
    // was not known at creation time.
    if (!jobSpec.sourcePlatform) {
      const { detectSourcePlatform, resolveChromeCfg, fingerprintResolvedChromeCfg } = require('../chrome_overlay_ffmpeg');
      const _apiUrls = [
        ...(b.urls || []),
        ...(b.url ? [b.url] : []),
        ...(jobSpec.sourceConfig?.urls || []),
        ...(jobSpec.order?.inputs?.sources || []),
      ];
      const _detectedPlatform = detectSourcePlatform(_apiUrls);
      if (_detectedPlatform) {
        jobSpec.sourcePlatform = _detectedPlatform;
        // Re-freeze chrome config with platform colors since job_spec.js didn't have the URLs yet.
        try {
          const { loadCustomerConfig: _lcc } = require('../job_spec');
          const _cc = _lcc(customerId);
          const _ct = jobSpec.designSpec?.chrome?.resolvedContentType || jobSpec.contentType || 'clips';
          const _cfg = resolveChromeCfg(_cc, _ct, _detectedPlatform);
          jobSpec.designSpec                       = jobSpec.designSpec || {};
          jobSpec.designSpec.chrome                = jobSpec.designSpec.chrome || {};
          jobSpec.designSpec.chrome.resolvedCfg    = _cfg;
          jobSpec.designSpec.chrome.resolvedHash   = fingerprintResolvedChromeCfg(_cfg);
          jobSpec.designSpec.chrome.sourcePlatform = _detectedPlatform;
        } catch (_e) { /* non-fatal */ }
      }
    }

    // CPD-448: Persist post-processing effects so assembly_postprocess can apply them.
    // effects.layout.{square,portrait}, effects.audio.{loudnorm,denoise}, effects.color.{lut},
    // effects.transitions, effects.visual, effects.ai — all read by assembly_postprocess.js.
    if (b.effects && typeof b.effects === 'object') {
      jobSpec.effects = b.effects;
    }

    // Bake qaMode from customer config into jobSpec so portals don't reload config
    if (!jobSpec.qaMode) {
      const { loadCustomerConfig: _loadCC } = require('../job_spec');
      jobSpec.qaMode = _loadCC(customerId)?.qaMode || 'suggestive';
    }

    // Wire order fields so portals can access them
    jobSpec.order           = jobSpec.order           || {};
    jobSpec.order.inputs    = jobSpec.order.inputs    || {};
    jobSpec.order.inputs.entry = entry;
    if (entry === 'fetch')  jobSpec.order.inputs.url    = b.url || (b.sourceConfig?.urls?.[0] || null);
    if (entry === 'upload') jobSpec.order.inputs.fileId = b.fileId || null;

    const orderFields = b.order || {};
    // Accept topic/tone/duration at either top-level (b.topic) or nested (b.order.topic)
    const topicVal    = b.topic    || orderFields.topic;
    const toneVal     = b.tone     || orderFields.tone;
    const durationVal = b.duration || orderFields.duration;
    const formatVal   = b.format   || orderFields.format;
    if (topicVal)    jobSpec.order.topic    = topicVal;
    if (toneVal)     jobSpec.order.tone     = toneVal;
    if (durationVal) jobSpec.order.duration = durationVal;
    if (formatVal)   jobSpec.order.format   = formatVal;
    // CPD-486: wire streamer from request body so chrome overlay and publish copy
    // can use the real streamer name rather than falling back to brandName or blank.
    const streamerVal = b.streamer || orderFields.streamer;
    if (streamerVal) {
      jobSpec.order.inputs.streamer = streamerVal;
      // Also write to designSpec.chrome.showName so job_grader branding_config check passes.
      jobSpec.designSpec               = jobSpec.designSpec               || {};
      jobSpec.designSpec.chrome        = jobSpec.designSpec.chrome        || {};
      if (!jobSpec.designSpec.chrome.showName) jobSpec.designSpec.chrome.showName = streamerVal;
    }
    // CPD-193: Wire platforms from top-level b.platforms or b.order.publish.platforms into
    // order.publish.platforms so _formatJob returns them and the E2E metadata fallback
    // scorer can award the +15 platforms match bonus.
    const _platforms = b.platforms || orderFields.publish?.platforms;
    if (Array.isArray(_platforms) && _platforms.length) {
      jobSpec.order.publish             = jobSpec.order.publish || {};
      jobSpec.order.publish.platforms   = _platforms;
    }

    // CPD-278: Forward clipSpec so assembly routes through _assembleCompactClipSpec / _assembleExtractClipSpec.
    // Without this, COMPACT jobs fall through to _downloadClips, skipping trim and ordering entirely.
    if (b.clipSpec && typeof b.clipSpec === 'object') jobSpec.clipSpec = b.clipSpec;

    // CPD-QA: Extract and validate all feature inputs using feature_input_schema — the
    // canonical source of truth shared with jobs_c1.js and the dashboard wizard.
    // addOns is the preferred path; top-level body fields are accepted as a fallback.
    const _addOns = b.addOns || {};

    // Validate — return 400 if any feature has invalid inputs (wrong preset, etc.)
    const _validation = validateFeatureInputs(_addOns);
    if (!_validation.valid) {
      return res.status(400).json({
        error:   'invalid_feature_inputs',
        message: 'One or more feature inputs are invalid. See the errors array for details.',
        errors:  _validation.errors,
        docsUrl: '/v1/feature-inputs',
      });
    }

    // Extract canonical feature config from addOns
    const _featureConfig = extractFeatureConfig(_addOns);
    if (_featureConfig.captions   && !jobSpec.captions)   jobSpec.captions   = _featureConfig.captions;
    if (_featureConfig.colorGrade && !jobSpec.colorGrade) jobSpec.colorGrade = _featureConfig.colorGrade;
    if (_featureConfig.effects    && !jobSpec.effects)    jobSpec.effects    = _featureConfig.effects;
    if (_featureConfig.audioOpts  && !jobSpec.audioOpts)  jobSpec.audioOpts  = _featureConfig.audioOpts;
    if (_featureConfig.layout) {
      jobSpec.effects = jobSpec.effects || {};
      jobSpec.effects.layout = { ...jobSpec.effects.layout, ..._featureConfig.layout };
    }

    // Top-level body fallback (backwards compat — older clients send b.captions, b.colorGrade etc.)
    if (b.captions   && typeof b.captions   === 'object' && !jobSpec.captions)   jobSpec.captions   = b.captions;
    if (b.colorGrade && typeof b.colorGrade === 'object' && !jobSpec.colorGrade) jobSpec.colorGrade = b.colorGrade;
    if (b.effects    && typeof b.effects    === 'object' && !jobSpec.effects)    jobSpec.effects    = b.effects;
    if (b.audioOpts  && typeof b.audioOpts  === 'object' && !jobSpec.audioOpts)  jobSpec.audioOpts  = b.audioOpts;

    // staging: true — skip Portal 5 (publish) so output lands in R2 for human review.
    // Use GET /v1/jobs/:id/staging-assets to inspect, then POST /v1/jobs/:id/approve-publish to publish.
    if (b.staging === true) {
      jobSpec.staging = true;
      const { resolveActivePortals } = require('../job_spec');
      resolveActivePortals(jobSpec);
    }

    const { creditCost } = calculateCreditCost({
      planTier,
      durationMins: jobSpec.durationMins || 5,
      sourceType:   jobSpec.sourceType,
      addOns:       jobSpec.addOns,
      contentType:  jobSpec.contentType,
    });

    if (creditCost > 0) {
      const creditResult = await consumeCredits(customerId, jobSpec.jobId, creditCost, jobSpec.brandId || null);
      if (creditResult.status === 'PAUSED' || creditResult.status === 'INSUFFICIENT') {
        return res.status(402).json({
          error: 'insufficient_credits',
          message: 'Insufficient credits. Purchase a pack to continue.',
          creditCost,
          balance: creditResult.balance || 0,
        });
      }
      // Notify if balance just dropped below 10% of monthly allowance
      if (creditResult.balance != null && creditResult.included != null && creditResult.included > 0) {
        const pct = creditResult.balance / creditResult.included;
        if (pct <= 0 && creditResult.balance === 0) {
          createNotification(customerId, {
            type:      'credits_exhausted',
            title:     "You've used all your credits",
            body:      'Upgrade your plan or buy a credit pack to keep going.',
            actionUrl: '/dashboard/billing',
          });
        } else if (pct > 0 && pct <= 0.1) {
          createNotification(customerId, {
            type:      'credits_low',
            title:     `Running low on credits (${creditResult.balance} remaining)`,
            body:      'Buy a credit pack to avoid interruptions.',
            actionUrl: '/dashboard/billing',
          });
        }
      }
    }

    // Upsert creates the row with job_spec set — required so the terminal-status
    // guard in updateJobSpec (which checks job_spec IS NOT NULL) works on first write.
    await db.upsertJobRow(jobSpec.jobId, jobSpec);

    // Fire-and-forget portal sequence
    const { nrJobCreated, nrJobComplete, nrJobFailed, nrPortalStart, nrPortalPass, nrPortalFail } = require('../nr_events');
    const _jobId  = jobSpec.jobId;
    const _jobStartMs = Date.now();
    nrJobCreated(jobSpec);
    const _spec   = jobSpec; // captured reference — portals mutate this in place
    const _persist = (updates) => {
      Object.assign(_spec, updates);
      db.updateJobSpec(_jobId, _spec)
        .catch((e) => console.error('[v1] persistJobStatus updateJobSpec failed:', e.message));
      db.saveJob(_jobId, _spec)
        .catch((e) => console.error('[v1] persistJobStatus saveJob failed:', e.message));
    };

    // CPD-266: Register this job in the shared active-pipeline registry so
    // gracefulShutdown() can wait for it before the process exits on SIGTERM.
    const { registerPipelineJob, unregisterPipelineJob } = require('../active_jobs');
    const _pipelineDone = registerPipelineJob(_jobId);

    setImmediate(async () => {
      try {
        // ── Script generation (C1 pipeline) ─────────────────────────────────
        // Portal 1 is a QA gate — it needs filledScript already populated.
        // Generate the script here from the job spec's source URLs before the
        // portal sequence starts, unless the caller pre-supplied one.
        if (!_spec.filledScript) {
          try {
            _persist({ status: 'running', currentPortal: 'script_gen', updatedAt: new Date().toISOString() });
            const { generateJobScript } = require('../script_gen_service');
            const scriptResult = await generateJobScript(_spec);
            _spec.filledScript     = scriptResult.filledScript;
            _spec.orderedClipUrls  = scriptResult.orderedClipUrls;
            // Persist AI publishCopy so portal5 reads real titles instead of topic fallback
            if (scriptResult.publishCopy) {
              if (!_spec.state) _spec.state = {};
              if (!_spec.state.savedOutputs) _spec.state.savedOutputs = {};
              _spec.state.savedOutputs.publishCopy = scriptResult.publishCopy;
            }
            await db.updateJobSpec(_jobId, _spec);
            console.log(`[v1] ${_jobId}: script generated (${_spec.filledScript?.length || 0} chars)`);
          } catch (scriptErr) {
            logError('CPD126_SCRIPT_GEN_FAILED', scriptErr, { jobId: _jobId });
            _persist({ status: 'failed', failedPortal: 'script_gen', updatedAt: new Date().toISOString() });
            return;
          }
        }

        // CPD-181/CPD-192: EXTRACT flow — if source URL is a Twitch VOD, extract clips before
        // the portal sequence. createJobSpec stores URLs at order.inputs.sourceConfig.urls (not
        // at the top-level spec.sourceConfig), so check both paths.
        {
          const _sourceUrls = (
            _spec.sourceConfig?.urls ||
            _spec.order?.inputs?.sourceConfig?.urls ||
            (_spec.order?.inputs?.url ? [_spec.order.inputs.url] : [])
          );
          const _isTwitchVod = _sourceUrls.some((u) => /twitch\.tv\/videos\/\d+/.test(String(u)));
          // CPD-284: Kick VODs (kick.com/video/ID) use the same yt-dlp extraction path as Twitch.
          const _isKickVod   = !_isTwitchVod && _sourceUrls.some((u) => /kick\.com\/video\/\d+/.test(String(u)));
          // CPD-284: YouTube watch URLs — yt-dlp handles these the same way.
          const _isYouTubeVod = !_isTwitchVod && !_isKickVod && _sourceUrls.some((u) => /(?:youtube\.com\/watch|youtu\.be\/)/.test(String(u)));
          if (_isTwitchVod || _isKickVod || _isYouTubeVod) {
            const _platform = _isTwitchVod ? 'twitch' : _isKickVod ? 'kick' : 'youtube';
            try {
              _persist({ status: 'running', currentPortal: 'vod_extract', updatedAt: new Date().toISOString() });
              const { extractVodClips } = require('../assembly_service');
              const _vodUrlPattern = _isTwitchVod
                ? /twitch\.tv\/videos\/\d+/
                : _isKickVod
                ? /kick\.com\/video\/\d+/
                : /(?:youtube\.com\/watch|youtu\.be\/)/;
              const _vodUrl = _sourceUrls.find((u) => _vodUrlPattern.test(String(u)));
              console.log(`[v1] ${_jobId}: ${_platform.toUpperCase()} VOD detected — using yt-dlp extract path`);
              // CPD-201: Pass isVertical so extracted clips are cropped to 9:16 for
              // vertical_reel jobs (TikTok/Instagram) rather than the default 16:9.
              const _isVerticalExtract = _spec.productionProfile === 'vertical_reel';
              // CPD-209/CPD-211: Derive clip count from durationMins per EXTRACT flow spec.
              // Target 60s per clip for short-form (TikTok/Reels/Shorts), 90s for YouTube long-form.
              // Cap at 5 clips per job regardless of duration.
              const _extractPlatforms = (
                _spec.order?.publish?.platforms ||
                _spec.platforms ||
                (_spec.order?.inputs?.platform ? [_spec.order.inputs.platform] : [])
              ).map((p) => String(p).toLowerCase());
              const _isLongformPlatform = _extractPlatforms.some((p) => p === 'youtube');
              const _targetClipSecs = _isLongformPlatform ? 90 : 60;
              const _durationMins = _spec.durationMins || _spec.order?.inputs?.durationMins || 3;
              const _derivedClipCount = Math.min(5, Math.max(1, Math.ceil(_durationMins * 60 / _targetClipSecs)));
              console.log(`[v1] ${_jobId}: EXTRACT clipCount=${_derivedClipCount} (durationMins=${_durationMins}, targetClipSecs=${_targetClipSecs})`);
              // CPD-246: use viewer-highlight timestamps from Twitch if available
              const _vodClipTimestamps = _spec.sourceConfig?.vodClipTimestamps || null;
              const _extractedPaths = await extractVodClips(_vodUrl, {
                clipCount: _derivedClipCount,
                maxClipSecs: _targetClipSecs,
                jobId: _jobId,
                isVertical: _isVerticalExtract,
                vodClipTimestamps: _vodClipTimestamps,
              });
              // Replace source references with local clip paths at ALL known locations so
              // portal0 (sourceConfig.urls) and assembleForJob (order.inputs) both see the
              // extracted files rather than the original Twitch VOD page URL.
              _spec.sourceConfig = { urls: _extractedPaths };
              _spec.order = _spec.order || {};
              _spec.order.inputs = _spec.order.inputs || {};
              _spec.order.inputs.sourceConfig = { urls: _extractedPaths };
              _spec.order.inputs.url = _extractedPaths[0] || _spec.order.inputs.url;
              _spec.order.inputs.items = _extractedPaths.map((p) => ({ localPath: p, url: `file://${p}` }));
              await db.updateJobSpec(_jobId, _spec);
              console.log(`[v1] ${_jobId}: VOD EXTRACT complete — ${_extractedPaths.length} clips ready`);

              // CPD-238: For show_commentary EXTRACT jobs the script was generated with the
              // VOD URL as a single source, producing only INTRO + STORY1_CLIP + OUTRO.
              // Now that we have the actual clip count, regenerate the script with the real
              // extracted clips so multi-clip TRANSITION sections (STORY2, STORY3…) are written.
              //
              // CPD-273: Also regen for 'clips' content type when TTS is active and multiple
              // clips were extracted — the original single-source script only has a generic intro
              // TTS block. Regen produces per-clip narration sections matching extracted content.
              const _hasTts = (_spec.addOns?.tts?.active || _spec.order?.addOns?.tts?.active ||
                               (_spec.features || []).includes('tts'));
              const _needsMultiClipRegen = _extractedPaths.length > 1 && (
                _spec.contentType === 'show_commentary' ||
                (_spec.contentType === 'clips' && _hasTts)
              );
              if (_needsMultiClipRegen) {
                try {
                  _persist({ status: 'running', currentPortal: 'script_regen', updatedAt: new Date().toISOString() });
                  const { generateJobScript } = require('../script_gen_service');
                  // CPD-246: inject clip titles from Twitch popular clips as script grounding.
                  // This tells the script generator WHAT IS ACTUALLY IN each clip so the
                  // TTS narration does not invent content that isn’t visible on screen.
                  const _timestamps = _spec.sourceConfig?.vodClipTimestamps || [];
                  if (_timestamps.length) {
                    _spec.extractedClipDescriptions = _timestamps.slice(0, _extractedPaths.length)
                      .map((t, i) => `Clip ${i + 1}: ${t.title || 'highlight moment'} (starts at ${t.start_s}s in stream)`);
                    console.log(`[v1] ${_jobId}: clip grounding injected for script regen: ${_spec.extractedClipDescriptions.join(' | ')}`);
                  }
                  _spec.filledScript = null; // clear so generateJobScript re-runs
                  const regenResult = await generateJobScript(_spec);
                  _spec.filledScript    = regenResult.filledScript;
                  _spec.orderedClipUrls = regenResult.orderedClipUrls;
                  if (regenResult.publishCopy) {
                    if (!_spec.state) _spec.state = {};
                    if (!_spec.state.savedOutputs) _spec.state.savedOutputs = {};
                    _spec.state.savedOutputs.publishCopy = regenResult.publishCopy;
                  }
                  await db.updateJobSpec(_jobId, _spec);
                  console.log(`[v1] ${_jobId}: show_commentary script regenerated with ${_extractedPaths.length} clips (${_spec.filledScript?.length || 0} chars)`);
                } catch (regenErr) {
                  logError('CPD238_SCRIPT_REGEN_FAILED', regenErr, { jobId: _jobId });
                  // Non-fatal — continue with the 1-clip script rather than failing the job
                  console.warn(`[v1] ${_jobId}: show_commentary script regen failed, using single-clip script`);
                }
              }
            } catch (vodErr) {
              logError('CPD181_VOD_EXTRACT_FAILED', vodErr, { jobId: _jobId });
              if (_isYouTubeVod) {
                // CPD-351: YouTube yt-dlp often fails from Render datacenter IPs without
                // YOUTUBE_COOKIES_BASE64 (bot detection). Rather than killing the job here,
                // fall back to the direct-URL path: portal0 validates via YouTube Data API,
                // assembly retries yt-dlp at job time (may succeed or fail with a clear error).
                // This avoids portals:[] in the job response for YouTube failures.
                console.warn(`[v1] ${_jobId}: YouTube VOD extract failed (${vodErr.message.slice(0, 80)}) — falling back to direct URL path (portal0 + assembly)`);
              } else {
                _persist({ status: 'failed', failedPortal: 'vod_extract', failReason: vodErr.message, updatedAt: new Date().toISOString() });
                return;
              }
            }
          }
        }

        // WAN pre-generation — runs before _hasSourceClips check so the generated
        // local clip paths are available when we decide which portals to activate.
        // sourceType lives at order.inputs.sourceType (set by createJobSpec), not at top level.
        if (_spec.order?.inputs?.sourceType === 'wan_gen') {
          const { _runWanPreGeneration } = require('../routes/jobs_c1');
          const preGenOk = await _runWanPreGeneration(_spec, _jobId);
          if (!preGenOk) {
            logError('CPD126_WAN_PREGEN_FAILED', 'WAN pre-generation failed — aborting pipeline', { jobId: _jobId });
            _persist({ status: 'failed', failedPortal: 'wan_pregen', failReason: 'wan_pregen_failed', updatedAt: new Date().toISOString() });
            return;
          }
          await db.updateJobSpec(_jobId, _spec);
        }

        // For topic-only jobs (no source video clips), mark video-dependent
        // portals inactive BEFORE runPortalSequence so resolveActivePortals
        // excludes them from the active portal list at startup.
        // NOTE: WAN pre-gen populates order.inputs.items with localPath entries —
        // include localPath in the check so wan_gen jobs proceed to video portals.
        const _hasSourceClips = (
          (_spec.sourceConfig?.urls?.length > 0) ||
          (_spec.orderedClipUrls?.length > 0) ||
          (_spec.order?.inputs?.url) ||
          (_spec.order?.inputs?.items?.some((it) => it.url || it.videoUrl || it.clipUrl || it.localPath)) ||
          // CPD-528: upload-entry jobs have no URLs but do have fileId / uploadSessionId
          (_spec.sourceConfig?.uploadSessionId) ||
          (_spec.order?.inputs?.fileId)
        );
        if (!_hasSourceClips) {
          console.log(`[v1] ${_jobId}: topic-only — marking video/spec portals inactive before sequence`);
          _spec.portals = _spec.portals || {};
          // All video-dependent portals are skipped for topic-only jobs.
          // portal1b, portal2, portal3a: need assembled video
          // portal3b: needs commitments/designSpec (not present in Operate API jobs)
          // portal4: chrome overlay — needs assembled video
          // portal5: publish — needs assembled video to upload
          ['portal1b', 'portal2', 'portal3a', 'portal3b', 'portal4', 'portal5'].forEach((vpk) => {
            if (_spec.portals[vpk]) _spec.portals[vpk].active = false;
            else _spec.portals[vpk] = { active: false, reason: 'topic_only — no source video or design spec' };
          });
          // CPD-598: flag so the job grader skips output_exists check — script is the deliverable
          _spec.isTopicOnly = true;
          await db.updateJobSpec(_jobId, _spec);
        }

        const { runPortalSequence } = require('../portal_policy_runner');
        const workers = _resolvePortalWorkers(_spec);
        const _storeReport = (pk, result) => {
          if (!result) return;
          _spec.portalReports = _spec.portalReports || {};
          _spec.portalReports[pk] = {
            passed:     result.passed ?? false,
            failReason: result.failReason || result.reason ||
              result.fixDirective?.delivered ||
              ((!result.passed && result.score !== undefined) ? `score:${result.score} outcome:${result.outcome}` : null),
            outcome:    result.outcome || null,
            score:      result.score  ?? null,
            portal:     result.portal ?? pk,
            completedAt: result.completedAt || new Date().toISOString(),
            // Preserve portal4 upload signal so portal5 can read it from portalReports
            ...(result.uploadSignal !== undefined ? { uploadSignal: result.uploadSignal } : {}),
            // Preserve portal3a sample findings so grader can check chromeVisible
            ...(result.sampleFindings   !== undefined ? { sampleFindings: result.sampleFindings }   : {}),
            // CPD-486: Preserve portal3a ffmpegScan (loudness/black frames) so grader qa_loudness
            // and qa_black_frames checks can read scan results from portalReports.
            ...(result.ffmpegScan       !== undefined ? { ffmpegScan:     result.ffmpegScan     }   : {}),
          };
          // Preserve output artifacts the portal wrote to _spec directly
          if (result.confirmedFormat) _spec.confirmedFormat = result.confirmedFormat;
          if (result.confirmedSources) _spec.confirmedSources = result.confirmedSources;
          // CPD-422/430: Propagate thumbnail candidate URL so grader thumbnail check passes.
          // initiateApprovalStage sets thumbnail.r2Url=null until approval; use best candidate.
          if (pk === 'thumbnail_ext' && result.thumbnail) {
            const _thumb = result.thumbnail;
            const _bestUrl = _thumb.designedUrl || _thumb.vectcutUrl ||
              (_thumb.candidates || []).find((c) => c.url)?.url || null;
            if (_bestUrl) {
              _spec.thumbnailUrl = _bestUrl;
              if (!_spec.state) _spec.state = {};
              if (!_spec.state.savedOutputs) _spec.state.savedOutputs = {};
              _spec.state.savedOutputs.thumbnail = _spec.state.savedOutputs.thumbnail || {};
              _spec.state.savedOutputs.thumbnail.r2Url = _bestUrl;
            }
          }
        };

        runPortalSequence({
          jobSpec: _spec,
          portalWorkers: workers,
          extensionWorkers: _resolveExtensionWorkers(_spec),
          onPortalStart:  (pk) => {
            console.log(`[v1] ${_jobId}: portal ${pk} started`);
            nrPortalStart(_spec, pk);
            _persist({ status: 'running', currentPortal: pk, updatedAt: new Date().toISOString() });
          },
          onPortalPass:   async (pk, result) => {
            console.log(`[v1] ${_jobId}: portal ${pk} passed`);
            nrPortalPass(_spec, pk, result?.score);
            _storeReport(pk, result);
            _persist({ status: 'running', currentPortal: pk, updatedAt: new Date().toISOString() });

            // CPD-485: all post-portal hooks now use shared pipeline_assembly.js
            // so dashboard/BullMQ/v1 paths are guaranteed identical behaviour.

            // Assembly: after portal1 for script jobs, after portal0 for clip-only jobs
            if ((pk === 'portal1') || (pk === 'portal0' && !isPortal1Active(_spec))) {
              await runAssemblyAndPostProcess(_spec, _jobId, {
                logPrefix: '[v1]',
                persist:   (patch) => _persist(patch),
              });
            }

            // TTS mix + chrome after tts_ext
            if (pk === 'tts_ext' && _spec.assembledPath) {
              const _ttsAudio = result?.audioPath || _spec.state?.tts?.audioPath;
              if (_ttsAudio) {
                await runTtsMixAndChrome(_spec, _jobId, _ttsAudio, {
                  logPrefix: '[v1]',
                  persist:   (patch) => _persist(patch),
                });
              }
            }

            // Chrome safety net on portal3a
            if (pk === 'portal3a') {
              await ensureChromeApplied(_spec, _jobId, { logPrefix: '[v1]' });
            }
          },
          onPortalFail:   (pk, result) => {
            logError('CPD126_PORTAL_FAIL', result?.failReason || 'non-compliant', { jobId: _jobId, pk });
            nrPortalFail(_spec, pk, result?.failReason || result?.reason);
            _storeReport(pk, result);
            _persist({ status: 'non-compliant', currentPortal: pk, failedPortal: pk, updatedAt: new Date().toISOString() });
          },
          // CPD-485: shared handler — grade, persist, notify — now identical on all paths
          onJobComplete:  async (allResults) => {
            Object.entries(allResults || {}).forEach(([pk, r]) => _storeReport(pk, r));
            await runJobComplete(_spec, _jobId, {
              jobStartMs:    _jobStartMs,
              logPrefix:     '[v1]',
              nrJobComplete,
            });
          },
          onJobFailed:    async (fp, result) => {
            logError('CPD126_JOB_FAILED', result?.failReason || fp, { jobId: _jobId });
            nrJobFailed(_spec, fp, result?.failReason || result?.reason);
            _storeReport(fp, result);
            createNotification(_spec.customerId, {
              type:      'job_failed',
              title:     'Job failed — see details',
              body:      result?.failReason || result?.reason || fp || null,
              actionUrl: `/dashboard/jobs/${_jobId}`,
            });
            Object.assign(_spec, { status: 'failed', failedPortal: fp, updatedAt: new Date().toISOString() });
            try {
              await db.updateJobSpec(_jobId, _spec);
              await db.saveJob(_jobId, _spec);
            } catch (e) {
              console.error(`[v1] ${_jobId}: onJobFailed final persist failed:`, e.message);
            }
          },
          persistJobStatus: ({ portalKey: pKey, phase }) => {
            _persist({ status: phase, currentPortal: pKey, updatedAt: new Date().toISOString() });
          },
        }).catch((err) => {
          // Catch unhandled portal worker exceptions so the job is marked failed
          logError('CPD126_PORTAL_SEQUENCE_ERROR', err, { jobId: _jobId });
          _persist({ status: 'failed', failedPortal: _spec.currentPortal || 'unknown', updatedAt: new Date().toISOString() });
        }).finally(() => {
          unregisterPipelineJob(_jobId);
          _pipelineDone();
        });
      } catch (err) {
        logError('CPD126_PORTAL_START_FAIL', err, { jobId: _jobId });
        _persist({ status: 'failed', failedPortal: 'startup', updatedAt: new Date().toISOString() });
        unregisterPipelineJob(_jobId);
        _pipelineDone();
      }
    });

    // CPD-211: Build suggestedDefaults for EXTRACT jobs so the dashboard/API caller
    // can show customers what the pipeline chose and why (one-line plain-English reason).
    let _suggestedDefaults = null;
    if (jobSpec.order?.inputs?.sourceType === 'vod_extract' || jobSpec.sourceType === 'vod_extract') {
      const _durationMins    = jobSpec.durationMins || jobSpec.order?.inputs?.durationMins || 3;
      const _extPlatforms    = (jobSpec.order?.publish?.platforms || []).map((p) => String(p).toLowerCase());
      const _isLongformP     = _extPlatforms.some((p) => p === 'youtube');
      const _targetClipSecs  = _isLongformP ? 90 : 60;
      const _suggestedCount  = Math.min(5, Math.max(1, Math.ceil(_durationMins * 60 / _targetClipSecs)));
      const _minClipSec      = _isLongformP ? 60 : 15;
      const _maxClipSec      = _isLongformP ? 180 : 90;
      _suggestedDefaults = {
        suggestedClipCount:         _suggestedCount,
        suggestedClipDurationRange: { minSec: _minClipSec, maxSec: _maxClipSec },
        basis: `${_durationMins} min VOD → ${_suggestedCount} clip${_suggestedCount !== 1 ? 's' : ''} @ ` +
               `~${_targetClipSecs}s each (${_isLongformP ? 'YouTube long-form' : 'short-form'} target)`,
        canOverride: { maxClips: true, durationMins: true },
      };
    }

    // CPD-224: include polling hints so Operate-tier API customers know how to track jobs
    const _apiBase = process.env.API_BASE_URL || 'https://auraflux-api.onrender.com';
    const _contentType = jobSpec.contentType || b.content_type || 'clips';
    const _featureCount = Array.isArray(b.features) ? b.features.length : 0;
    const _baseMinutes  = _contentType.includes('commentary') ? 8 : 5;
    const _estimatedMinutes = Math.min(30, _baseMinutes + _featureCount * 2);
    res.status(202).json({
      jobId:            jobSpec.jobId,
      status:           'queued',
      staging:          jobSpec.staging || false,
      creditCost,
      planTier,
      createdAt:        new Date().toISOString(),
      pollUrl:          `${_apiBase}/v1/jobs/${jobSpec.jobId}`,
      estimatedMinutes: _estimatedMinutes,
      queuePosition:    1,
      webhookHint:      'Register POST /v1/webhooks to receive completion callbacks instead of polling',
      ...(_suggestedDefaults ? { suggestedDefaults: _suggestedDefaults } : {}),
    });
  } catch (err) {
    logError('CPD126_POST_JOB_FAIL', err, { customerId });
    res.status(500).json({ error: 'job_creation_failed', message: err.message });
  }
});

// ─── GET /v1/jobs ──────────────────────────────────────────────────────────────
router.get('/jobs', async (req, res) => {
  const customerId = req.user.id;
  const limit  = Math.min(parseInt(req.query.limit  || '20', 10), 100);
  const offset = parseInt(req.query.offset || '0', 10);
  const status = req.query.status || null;

  try {
    const rows = await db.listJobsByCustomer(customerId, limit + offset);
    let jobs = rows.slice(offset).map((r) => _formatJob(r, { operator: false }));
    if (status) jobs = jobs.filter(j => j.status === status);

    res.json({ jobs, limit, offset, count: jobs.length });
  } catch (err) {
    logError('CPD126_LIST_JOBS_FAIL', err, { customerId });
    res.status(500).json({ error: 'list_jobs_failed' });
  }
});

// ─── GET /v1/jobs/:id ──────────────────────────────────────────────────────────
router.get('/jobs/:id', async (req, res) => {
  try {
    const row = await db.loadJobRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.customer_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
    res.json(_formatJob(row, { operator: false }));
  } catch (err) {
    logError('CPD126_GET_JOB_FAIL', err, { jobId: req.params.id });
    res.status(500).json({ error: 'get_job_failed' });
  }
});

// ─── GET /v1/jobs/:id/result ───────────────────────────────────────────────────
router.get('/jobs/:id/result', async (req, res) => {
  try {
    const row = await db.loadJobRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.customer_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });

    const spec   = _parseSpec(row);
    const status = spec.status || 'queued';

    if (!['complete', 'published'].includes(status)) {
      return res.status(202).json({ status, message: 'Job not yet complete' });
    }

    res.json({
      jobId:        row.id,
      status,
      videoUrl:     spec.state?.savedOutputs?.r2VideoUrl || null,
      thumbnailUrl: spec.state?.savedOutputs?.thumbnail?.r2Url || null,
      publishCopy:  spec.state?.savedOutputs?.publishCopy || null,
      platforms:    spec.state?.publish?.results || [],
      completedAt:  row.updated_at || row.created_at,
    });
  } catch (err) {
    logError('CPD126_GET_RESULT_FAIL', err, { jobId: req.params.id });
    res.status(500).json({ error: 'get_result_failed' });
  }
});

// ─── DELETE /v1/jobs/:id ───────────────────────────────────────────────────────
router.delete('/jobs/:id', async (req, res) => {
  try {
    const row = await db.loadJobRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.customer_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });

    const spec = _parseSpec(row);
    if (['complete', 'published', 'failed'].includes(spec.status)) {
      return res.status(409).json({ error: 'cannot_cancel', message: `Job is already ${spec.status}` });
    }

    spec.status = 'cancelled';
    await db.updateJobSpec(row.id, spec);
    res.json({ jobId: row.id, status: 'cancelled' });
  } catch (err) {
    logError('CPD126_CANCEL_JOB_FAIL', err, { jobId: req.params.id });
    res.status(500).json({ error: 'cancel_failed' });
  }
});

// ─── GET /v1/feature-inputs ────────────────────────────────────────────────────
// Returns the canonical schema for every feature/enhancement supported by the API.
// Use this to discover what fields each feature requires and build valid payloads.
// No auth required — public discovery endpoint.
router.get('/feature-inputs', (req, res) => {
  res.json({
    description: 'Feature input schema — what each addOn/enhancement requires as input.',
    docsUrl:     'https://auraflux.co/developers/feature-inputs',
    features:    getPublicSchema(),
  });
});

// ─── GET /v1/templates ─────────────────────────────────────────────────────────
router.get('/templates', async (req, res) => {
  try {
    const templates = await db.listTemplates(req.user.id);
    res.json({ templates });
  } catch (err) {
    logError('CPD126_LIST_TEMPLATES_FAIL', err);
    res.status(500).json({ error: 'list_templates_failed' });
  }
});

// ─── POST /v1/templates ────────────────────────────────────────────────────────
router.post('/templates', async (req, res) => {
  const { name, description, jobSpec } = req.body || {};
  if (!name)    return res.status(400).json({ error: 'name is required' });
  if (!jobSpec) return res.status(400).json({ error: 'jobSpec is required' });

  // Resolve platforms from either top-level or nested order shape
  const platforms = (
    jobSpec.order?.publish?.platforms ||
    (Array.isArray(jobSpec.platforms) ? jobSpec.platforms : null) ||
    []
  );

  try {
    const tpl = await db.createTemplate(req.user.id, {
      name,
      description: description || null,
      contentType: jobSpec.contentType || jobSpec.productionProfile || null,
      platforms,
      jobSpec,
      recurrenceType: null, recurrenceDay: null, recurrenceTime: null,
    });
    res.status(201).json({ template: tpl });
  } catch (err) {
    console.error('[v1/templates] create_template_failed customerId=%s err=%s\n%s',
      req.user?.id, err.message, err.stack);
    logError('CPD126_CREATE_TEMPLATE_FAIL', err);
    res.status(500).json({ error: 'create_template_failed', detail: err.message });
  }
});

// ─── GET /v1/templates/:id ─────────────────────────────────────────────────────
router.get('/templates/:id', async (req, res) => {
  try {
    const tpl = await db.getTemplate(req.params.id, req.user.id);
    if (!tpl) return res.status(404).json({ error: 'not_found' });
    res.json({ template: tpl });
  } catch (err) {
    res.status(500).json({ error: 'get_template_failed' });
  }
});

// ─── DELETE /v1/templates/:id ──────────────────────────────────────────────────
router.delete('/templates/:id', async (req, res) => {
  try {
    const deleted = await db.deleteTemplate(req.params.id, req.user.id);
    if (!deleted) return res.status(404).json({ error: 'not_found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: 'delete_template_failed' });
  }
});

// ─── GET /v1/schedule ──────────────────────────────────────────────────────────
router.get('/schedule', async (req, res) => {
  try {
    const rows = await db.listJobsByCustomer(req.user.id, 100);
    const spec  = _parseSpec;
    const scheduled = rows
      .map(r => ({ row: r, spec: spec(r) }))
      .filter(({ spec: s }) => s.order?.publish?.scheduledPublishAt && ['queued','scheduled'].includes(s.status))
      .map(({ row, spec: s }) => ({
        jobId:              row.id,
        status:             s.status,
        scheduledPublishAt: s.order.publish.scheduledPublishAt,
        contentType:        s.contentType,
        platforms:          s.order?.publish?.platforms || [],
      }));

    res.json({ scheduled });
  } catch (err) {
    logError('CPD126_GET_SCHEDULE_FAIL', err);
    res.status(500).json({ error: 'get_schedule_failed' });
  }
});

// ─── PATCH /v1/jobs/:id/schedule ───────────────────────────────────────────────
router.patch('/jobs/:id/schedule', async (req, res) => {
  const { scheduledPublishAt } = req.body || {};
  if (!scheduledPublishAt) return res.status(400).json({ error: 'scheduledPublishAt is required (ISO 8601)' });

  try {
    const row = await db.loadJobRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.customer_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });

    const spec = _parseSpec(row);
    if (!spec.order) spec.order = {};
    if (!spec.order.publish) spec.order.publish = {};
    spec.order.publish.scheduledPublishAt = scheduledPublishAt;
    spec.status = 'scheduled';

    await db.updateJobSpec(row.id, spec);
    res.json({ jobId: row.id, scheduledPublishAt, status: 'scheduled' });
  } catch (err) {
    logError('CPD126_PATCH_SCHEDULE_FAIL', err);
    res.status(500).json({ error: 'patch_schedule_failed' });
  }
});

// ─── POST /v1/upload ───────────────────────────────────────────────────────────
router.post('/upload', async (req, res) => {
  const { filename, contentType: mimeType } = req.body || {};
  if (!filename) return res.status(400).json({ error: 'filename is required' });

  try {
    const { getUploadPresignedUrl } = require('../storage');
    const key = `uploads/${req.user.id}/${Date.now()}-${filename}`;
    const { uploadUrl, assetUrl } = await getUploadPresignedUrl(key, mimeType || 'video/mp4');
    res.json({ uploadUrl, assetUrl, key });
  } catch (err) {
    logError('CPD126_UPLOAD_FAIL', err);
    res.status(500).json({ error: 'upload_url_failed', message: err.message });
  }
});

// ─── GET /v1/account ───────────────────────────────────────────────────────────
router.get('/account', async (req, res) => {
  try {
    const credits = await getCreditBalance(req.user.id);
    const RATE_LIMITS = { diy: { rpm: 60, concurrent: 3 }, dwy: { rpm: 120, concurrent: 10 }, dfy: { rpm: 300, concurrent: null } };
    const limits  = RATE_LIMITS[req.user.planTier] || RATE_LIMITS.diy;

    res.json({
      customerId: req.user.id,
      email:      req.user.email,
      planTier:   req.user.planTier,
      credits: {
        balance:   (credits?.includedRemaining || 0) + (credits?.packCredits || 0),
        used:       credits?.includedUsed || 0,
        included:   credits?.creditsIncluded || 0,
        packs:      credits?.packCredits || 0,
      },
      rateLimits: limits,
    });
  } catch (err) {
    logError('CPD126_GET_ACCOUNT_FAIL', err);
    res.status(500).json({ error: 'get_account_failed' });
  }
});

// ─── API key routes — Operate tier only ──────────────────────────────────────
// Guided and Managed customers are operator-run (dwy/dfy). They submit jobs
// through the dashboard or via the operator; they do not integrate directly
// with the API. API key self-service is therefore an Operate-only feature.
function requireOperateTier(req, res, next) {
  if (req.user?.planTier !== 'operate') {
    return res.status(403).json({
      error: 'API key access is only available on the Operate plan.',
      label: 'OPERATE_ONLY',
    });
  }
  next();
}

// ─── GET /v1/account/api-keys ──────────────────────────────────────────────────
router.get('/account/api-keys', requireOperateTier, async (req, res) => {
  try {
    const keys = await listApiKeys(req.user.id);
    res.json({ apiKeys: keys });
  } catch (err) {
    res.status(500).json({ error: 'list_keys_failed' });
  }
});

// ─── POST /v1/account/api-keys ─────────────────────────────────────────────────
router.post('/account/api-keys', requireOperateTier, async (req, res) => {
  const { name } = req.body || {};
  try {
    const { key, record } = await createApiKey(req.user.id, req.user.planTier, name || '');
    res.status(201).json({
      key,   // plaintext — shown once
      id:        record.id,
      prefix:    record.key_prefix,
      name:      record.name,
      createdAt: record.created_at,
      warning:   'Store this key securely — it will not be shown again.',
    });
  } catch (err) {
    logError('CPD126_CREATE_KEY_FAIL', err);
    res.status(500).json({ error: 'create_key_failed' });
  }
});

// ─── DELETE /v1/account/api-keys/:keyId ────────────────────────────────────────
router.delete('/account/api-keys/:keyId', requireOperateTier, async (req, res) => {
  try {
    const revoked = await revokeApiKey(req.params.keyId, req.user.id);
    if (!revoked) return res.status(404).json({ error: 'key_not_found' });
    res.json({ revoked: true, keyId: req.params.keyId });
  } catch (err) {
    res.status(500).json({ error: 'revoke_key_failed' });
  }
});

// ─── GET /v1/jobs/:id/staging-assets ─────────────────────────────────────────
// Returns presigned R2 URLs (1h) for video + thumbnail, plus the full spec
// input and portal reports so reviewers can compare what-was-ordered vs output.
router.get('/jobs/:id/staging-assets', async (req, res) => {
  try {
    const row = await db.loadJobRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.customer_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });

    const spec = _parseSpec(row);
    const { getPresignedDownloadUrl } = require('../storage');

    const rawVideoUrl     = spec.state?.savedOutputs?.r2VideoUrl || null;
    const rawThumbnailUrl = spec.state?.savedOutputs?.thumbnail?.r2Url || null;

    let videoPresigned     = null;
    let thumbnailPresigned = null;

    try {
      if (rawVideoUrl)     videoPresigned     = await getPresignedDownloadUrl(rawVideoUrl,     3600);
      if (rawThumbnailUrl) thumbnailPresigned = await getPresignedDownloadUrl(rawThumbnailUrl, 3600);
    } catch (presignErr) {
      // If presign fails (e.g. no R2 creds), fall back to raw URL
      videoPresigned     = rawVideoUrl;
      thumbnailPresigned = rawThumbnailUrl;
    }

    // Pull script text — C1 API stores in spec.filledScript; C0 used spec.state.script.*
    const scriptText =
      spec.filledScript ||
      spec.state?.script?.finalScript ||
      spec.state?.script?.correctedScript ||
      spec.state?.script?.rawScript ||
      spec.portal2Report?.script ||
      null;

    const portalSummary = _buildDetailedPortalSummary(spec);

    res.json({
      jobId:       row.id,
      status:      spec.status || 'queued',
      staging:     spec.staging || false,
      input: {
        entry:        spec.order?.inputs?.entry || null,
        productionProfile: spec.productionProfile || null,
        contentType:  spec.contentType   || null,
        sourceType:   spec.sourceType    || null,
        tone:         spec.order?.tone   || null,
        topic:        spec.order?.topic  || spec.order?.userPrompt || null,
        duration:     spec.order?.duration || null,
        platforms:    spec.order?.publish?.platforms || [],
        planTier:     spec.planTier      || null,
        wizardConfig: spec.wizardConfig  || null,
        submittedAt:  Number(row.created_at) ? new Date(Number(row.created_at)).toISOString() : row.created_at,
      },
      output: {
        videoUrl:     videoPresigned,
        thumbnailUrl: thumbnailPresigned,
        script:       scriptText,
        publishCopy:  spec.state?.publishCopy || spec.publishCopy || null,
        savedOutputs: spec.state?.savedOutputs || null,
      },
      portalReports: portalSummary,
      urlExpiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    });
  } catch (err) {
    logError('CPD126_STAGING_ASSETS_FAIL', err);
    res.status(500).json({ error: 'staging_assets_failed', message: err.message });
  }
});

// ─── POST /v1/jobs/:id/approve-publish ────────────────────────────────────────
// After reviewing staging assets, approve the job for publish via upload-post.
// Uses the stored upload-post profile for the customer's clipzworldnews accounts.
router.post('/jobs/:id/approve-publish', async (req, res) => {
  try {
    const row = await db.loadJobRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.customer_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });

    const spec = _parseSpec(row);
    const videoUrl = spec.state?.savedOutputs?.r2VideoUrl || null;

    if (!videoUrl) {
      return res.status(422).json({ error: 'no_output', message: 'Job has no video output yet — pipeline may still be running.' });
    }

    // Generate a presigned URL for upload-post to fetch from
    let { getPresignedDownloadUrl } = require('../storage');
    let signedVideoUrl;
    try {
      signedVideoUrl = await getPresignedDownloadUrl(videoUrl, 7200); // 2h for upload-post to fetch
    } catch {
      signedVideoUrl = videoUrl;
    }

    // Inject presigned URL into the spec so retryPlatformUpload can find it
    if (!spec.state) spec.state = {};
    if (!spec.state.savedOutputs) spec.state.savedOutputs = {};
    spec.state.savedOutputs.r2VideoUrl = signedVideoUrl;

    const { applyPublishRequestToSpec, assertPublishCredentials, assertPublishReadiness, clearFailedPublishState, launchApprovePublishBackground } =
      require('../services/approve_publish');
    applyPublishRequestToSpec(spec, req.body);

    const readiness = assertPublishReadiness(spec, {
      forceApprove:
        (req.user.role === 'superadmin' || req.user.roles?.includes('superadmin')) &&
        (req.body.forceApprove === true || req.body.operatorOverride === true),
    });
    if (!readiness.ok) {
      return res.status(422).json({
        error: 'publish_not_ready',
        message: readiness.errors.join('; '),
        errors: readiness.errors,
      });
    }

    clearFailedPublishState(spec);
    if (!spec.jobId) spec.jobId = row.id;

    const { retryPlatformUpload, resolveUploadPostProfile } = require('../portals/portal5');
    const { canPublishDirect } = require('../publish/index');
    const platforms = req.body.platforms || spec.order?.publish?.platforms || [];

    const creds = await assertPublishCredentials(platforms, spec, {
      resolveUploadPostProfile,
      canPublishDirect,
    });
    if (!creds.ok) {
      return res.status(422).json(creds);
    }

    spec.status = 'publishing';
    spec.publishStatus = 'in_progress';
    spec.updatedAt = new Date().toISOString();
    await db.updateJobSpec(row.id, spec, { force: true });

    launchApprovePublishBackground({
      db,
      jobId: row.id,
      spec,
      platforms,
      retryPlatformUpload,
      logError,
    });

    return res.status(202).json({
      jobId: row.id,
      accepted: true,
      status: 'publishing',
      message: 'Publish started in background. Poll staging-assets for publishResults.',
    });
  } catch (err) {
    logError('CPD126_APPROVE_PUBLISH_FAIL', err);
    res.status(500).json({ error: 'approve_publish_failed', message: err.message });
  }
});

// ─── Operator Review Queue (CPD-431) ───────────────────────────────────────────
// All routes below require API key + superadmin role.
// Customers NEVER hit these endpoints — they are internal operator tooling only.
//
//   GET  /v1/operator/review-queue        — all jobs in operator_review status
//   GET  /v1/operator/jobs/:id            — full job detail (operator view)
//   POST /v1/operator/jobs/:id/release    — release to complete after operator resolution
//   POST /v1/operator/jobs/:id/reject     — reject / mark as failed after operator review

function _requireOperator(req, res, next) {
  // Must be superadmin or an internal operator token
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  const isSuper = req.user.role === 'superadmin' ||
                  req.user.roles?.includes('superadmin') ||
                  req.user.publicMetadata?.role === 'superadmin';
  if (!isSuper) return res.status(403).json({ error: 'operator_only' });
  next();
}

// GET /v1/operator/review-queue
router.get('/operator/review-queue', _requireOperator, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || '50', 10), 200);
    const offset = parseInt(req.query.offset || '0', 10);
    const rows   = await db.listAllJobRows ? await db.listAllJobRows(limit + offset) : [];
    const queue  = rows
      .filter((r) => {
        const s = _parseSpec(r);
        return (s.status || r.status) === 'operator_review';
      })
      .slice(offset)
      .map((r) => _formatJob(r, { operator: true }));
    res.json({ queue, count: queue.length, limit, offset });
  } catch (err) {
    logError('CPD431_REVIEW_QUEUE_FAIL', err);
    res.status(500).json({ error: 'review_queue_failed' });
  }
});

// GET /v1/operator/jobs/:id
router.get('/operator/jobs/:id', _requireOperator, async (req, res) => {
  try {
    const row = await db.loadJobRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json(_formatJob(row, { operator: true }));
  } catch (err) {
    logError('CPD431_OP_GET_JOB_FAIL', err, { jobId: req.params.id });
    res.status(500).json({ error: 'get_job_failed' });
  }
});

// POST /v1/operator/jobs/:id/release — operator resolved issues, release to complete
router.post('/operator/jobs/:id/release', _requireOperator, async (req, res) => {
  try {
    const row = await db.loadJobRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const spec = _parseSpec(row);
    if (spec.status !== 'operator_review') {
      return res.status(400).json({ error: 'not_in_review', status: spec.status });
    }
    const now = new Date().toISOString();
    const operatorId = req.user.id;
    const { resolutionNote } = req.body || {};
    spec.status = 'complete';
    if (!spec.state) spec.state = {};
    spec.state.operatorActions = [
      ...(spec.state.operatorActions || []),
      { action: 'release', operatorId, note: resolutionNote || null, at: now },
    ];
    spec.updatedAt = now;
    await db.updateJobSpec(req.params.id, spec);
    res.json({ ok: true, jobId: req.params.id, action: 'released', releasedAt: now });
  } catch (err) {
    logError('CPD431_OP_RELEASE_FAIL', err, { jobId: req.params.id });
    res.status(500).json({ error: 'release_failed' });
  }
});

// POST /v1/operator/jobs/:id/reject — operator cannot fix, mark as failed
router.post('/operator/jobs/:id/reject', _requireOperator, async (req, res) => {
  try {
    const row = await db.loadJobRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const spec = _parseSpec(row);
    if (spec.status !== 'operator_review') {
      return res.status(400).json({ error: 'not_in_review', status: spec.status });
    }
    const now = new Date().toISOString();
    const operatorId = req.user.id;
    const { reason } = req.body || {};
    spec.status = 'failed';
    spec.failReason = reason || 'Rejected by operator after review';
    if (!spec.state) spec.state = {};
    spec.state.operatorActions = [
      ...(spec.state.operatorActions || []),
      { action: 'reject', operatorId, reason: spec.failReason, at: now },
    ];
    spec.updatedAt = now;
    await db.updateJobSpec(req.params.id, spec);
    res.json({ ok: true, jobId: req.params.id, action: 'rejected', failReason: spec.failReason });
  } catch (err) {
    logError('CPD431_OP_REJECT_FAIL', err, { jobId: req.params.id });
    res.status(500).json({ error: 'reject_failed' });
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────────────
function _parseSpec(row) {
  if (!row.job_spec) return {};
  return typeof row.job_spec === 'string' ? JSON.parse(row.job_spec) : row.job_spec;
}

/**
 * Format a job row for API response.
 * @param {object} row — DB row
 * @param {object} [opts]
 * @param {boolean} [opts.operator] — true for operator/superadmin views — includes grade, gradeResult,
 *   operatorReview, gpt4oQA, and the real status (operator_review). Customers get status='processing'
 *   when the job is in operator_review so they never see a sub-100 grade or remediation detail.
 */
function _formatJob(row, { operator = false } = {}) {
  const spec = _parseSpec(row);
  // Prefer spec.status (updated by _persist) but fall back to the DB status column
  // which saveJob writes. This handles the race window before the first _persist write.
  const rawStatus = spec.status || row.status || 'queued';

  // CPD-431: Customer-facing status normalisation.
  // 'operator_review' is an internal operator state — customers see 'processing' so they
  // are never asked to fix anything themselves. Operators see the real status.
  const customerStatus = rawStatus === 'operator_review' ? 'processing' : rawStatus;
  const status = operator ? rawStatus : customerStatus;

  const base = {
    jobId:        row.id,
    status,
    entry:        spec.order?.inputs?.entry || null,
    productionProfile: spec.productionProfile || null,
    contentType:  spec.contentType || null,
    sourceType:   spec.sourceType  || null,
    planTier:     spec.planTier    || 'operate',
    topic:        spec.order?.topic    || null,
    tone:         spec.order?.tone     || null,
    format:       spec.order?.format   || null,
    platforms:    spec.order?.publish?.platforms || [],
    addOns:       spec.addOns  || null,
    outputUrl:    spec.state?.savedOutputs?.r2VideoUrl || spec.assembledVideoUrl || null,
    filledScript: spec.filledScript || spec.scaffold || null,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at || row.created_at,
    portals:      _buildPortalSummary(spec),
  };

  // CPD-486: Expose grade for all viewers so test scripts and SDK callers can
  // detect operator_review (shown as 'processing') and read the actual grade.
  // Customers see the grade number only — not the full gradeResult breakdown.
  base.grade = spec.grade ?? null;

  if (operator) {
    // Operator sees everything — grade breakdown, GPT-4o critique, remediation queue
    Object.assign(base, {
      gradeResult:      spec.gradeResult || null,
      gpt4oQA:          spec.state?.savedOutputs?.gpt4oQA || null,
      operatorReview:   spec.state?.operatorReview || null,
      cleanVideoUrl:    spec.state?.savedOutputs?.cleanVideoUrl || null,
      assemblyFailReason: spec.assemblyFailReason || null,
    });
  }

  return base;
}

function _adaptLegacyPortal(mod, jobSpec, timeoutMs) {
  return {
    runWorker: (_opts) => {
      const work = mod.run(jobSpec);
      if (!timeoutMs) return work;
      // CPD-447: return a failed result on timeout rather than throwing,
      // so the portal policy runner can handle it via normal sendback/intervention.
      const deadline = new Promise((resolve) =>
        setTimeout(() => resolve({
          passed:  false,
          outcome: 'timeout',
          reason:  `Worker timed out after ${Math.round(timeoutMs / 60000)}min`,
        }), timeoutMs)
      );
      return Promise.race([work, deadline]);
    },
    runIntervention: mod.commit ? (_opts) => mod.commit(jobSpec) : null,
    isPass:          (result) => !!(result?.passed),
  };
}

function _resolvePortalWorkers(jobSpec) {
  return {
    portal0:  _adaptLegacyPortal(require('../portals/portal0'),                jobSpec),
    portal1:  _adaptLegacyPortal(require('../portals/portal1'),                jobSpec, 10 * 60 * 1000),
    portal1b: _adaptLegacyPortal(require('../portals/portal1_video_reviewer'), jobSpec),
    portal2:  _adaptLegacyPortal(require('../portals/portal2'),                jobSpec),
    portal3a: _adaptLegacyPortal(require('../portals/portal3a'),               jobSpec),
    // portal3b: mismatch_fixable passes through to portal4 per spec design
    portal3b: {
      ...(_adaptLegacyPortal(require('../portals/portal3b'), jobSpec)),
      isPass: (result) => result?.passed === true || result?.outcome === 'mismatch_fixable',
    },
    portal4:  _adaptLegacyPortal(require('../portals/portal4'),                jobSpec),
    portal5:  _adaptLegacyPortal(require('../portals/portal5'),                jobSpec),
  };
}

// CPD-194: Extension workers must receive jobSpec on every invocation. portal_policy_runner.js
// calls runWorkerAttempt({ workerAttempt, phase }) — it does NOT pass jobSpec. Extension modules
// export runWorker({ jobSpec }), so without wrapping they always get jobSpec=undefined, causing
// feature-order checks (!jobSpec?.addOns?.tts?.active) to evaluate as true and skip every time.
function _adaptExtensionWorker(mod, jobSpec) {
  return {
    runWorker:       (_opts) => mod.runWorker({ jobSpec }),
    runIntervention: mod.runIntervention ? (_opts) => mod.runIntervention({ jobSpec }) : null,
    isPass:          (result) => (mod.isPass ? mod.isPass(result) : !!(result?.passed)),
  };
}

function _resolveExtensionWorkers(jobSpec) {
  return {
    tts_ext:            _adaptExtensionWorker(require('../portals/portal_tts_ext'),            jobSpec),
    heygen_ext:         _adaptExtensionWorker(require('../portals/portal_heygen_ext'),          jobSpec),
    shoppable_ext:      _adaptExtensionWorker(require('../portals/portal_shoppable_ext'),       jobSpec),
    burn_image_ext:     _adaptExtensionWorker(require('../portals/portal_burn_image_ext'),      jobSpec),
    highlight_trim_ext: _adaptExtensionWorker(require('../portals/portal_highlight_trim_ext'),  jobSpec),
    thumbnail_ext:      _adaptExtensionWorker(require('../portals/portal_thumbnail_ext'),       jobSpec),
    // CPD-431: GPT-4o deep quality + creative review — fires after portal3b when OPENAI_API_KEY set
    gpt4o_qa_ext:       _adaptExtensionWorker(require('../portals/portal_gpt4o_qa'),            jobSpec),
  };
}

function _buildPortalSummary(spec) {
  const reports = spec.portalReports || spec.gateReports || {};
  return Object.entries(reports).map(([key, r]) => ({
    portal:     key,
    passed:     r.passed === true,
    status:     r.policy?.status || (r.passed ? 'passed' : r.failReason ? 'failed' : 'pending'),
    failReason: r.passed ? undefined : (r.failReason || r.reason || undefined),
    score:      r.score ?? undefined,
  }));
}

function _buildDetailedPortalSummary(spec) {
  const reports = spec.portalReports || spec.gateReports || {};
  return Object.entries(reports).map(([key, r]) => ({
    portal:      key,
    passed:      r.passed === true,
    status:      r.policy?.status || (r.passed ? 'passed' : r.outcome || 'pending'),
    outcome:     r.outcome || null,
    score:       r.score  ?? null,
    failReason:  r.failReason || r.reason || null,
    completedAt: r.completedAt || null,
    violations:  r.prePublishValidation?.violations || r.violations || [],
    notes:       r.notes || r.summary || null,
  }));
}

// ─── POST /v1/concierge ────────────────────────────────────────────────────────
// CPD-247: API key auth alias for the concierge chat endpoint.
// The dashboard uses POST /concierge/chat (Clerk session auth). Operate/Guided/Managed
// API customers and E2E tests call POST /v1/concierge (API key auth — this route).
// Accepts: { messages: [{role, content}], currentSpec?: object }
// Returns: { ok, reply }
router.post('/concierge', async (req, res) => {
  const { messages = [], currentSpec = {} } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ ok: false, error: 'messages must be a non-empty array' });
  }
  try {
    const { chatWithConcierge } = require('../services/concierge');
    const planTier = req.user?.planTier || 'guided';
    const response = await chatWithConcierge(messages, currentSpec, { planTier });
    return res.json({ ok: true, reply: response });
  } catch (err) {
    const label = err.message?.includes('API_KEY') ? 'GEMINI_NOT_CONFIGURED' : 'CONCIERGE_ERROR';
    const status = label === 'GEMINI_NOT_CONFIGURED' ? 503 : 500;
    console.error(`[v1/concierge] error: ${err.message}`);
    return res.status(status).json({ ok: false, reply: '', error: err.message, label });
  }
});

module.exports = router;
