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
const { requireApiKeyAuth }  = require('../auth/api_key');
const { createJobSpec }      = require('../job_spec');
const { calculateCreditCost } = require('../services/credit_calculator');
const { consumeCredits } = require('../services/credits');
const { getCreditBalance } = require('../db');
const { createApiKey, listApiKeys, revokeApiKey } = require('../services/api_keys');
const { isFeatureEnabled }   = require('../services/feature_gate');
const { logError }           = require('../error_logger');
const db                     = require('../db/postgres');

const router = express.Router();

/** API-facing presentation profile → internal template/chrome key (until templates migrate off legacy keys). */
const PRODUCTION_PROFILE_TO_LEGACY_CONTENT_TYPE = {
  broadcast_desk: 'news',
  vertical_reel:  'clips',
  live_event:     'sports',
};
const LEGACY_CONTENT_TYPE_TO_PRODUCTION_PROFILE = {
  news: 'broadcast_desk',
  clips: 'vertical_reel',
  sports: 'live_event',
};

function _normalizeLegacyContentType(ct) {
  if (!ct || typeof ct !== 'string') return null;
  return ct.replace(/-short$/, '').replace(/-long$/, '');
}

function resolveProductionProfileAndContentType(body) {
  const b = body || {};
  if (b.productionProfile && PRODUCTION_PROFILE_TO_LEGACY_CONTENT_TYPE[b.productionProfile]) {
    return {
      productionProfile: b.productionProfile,
      contentType: PRODUCTION_PROFILE_TO_LEGACY_CONTENT_TYPE[b.productionProfile],
    };
  }
  if (b.contentType) {
    const base = _normalizeLegacyContentType(b.contentType) || b.contentType;
    const profile = LEGACY_CONTENT_TYPE_TO_PRODUCTION_PROFILE[base] || 'broadcast_desk';
    return { productionProfile: profile, contentType: base };
  }
  return { productionProfile: 'broadcast_desk', contentType: 'news' };
}

function resolveTemplateIdFromBody(b, contentTypeStr) {
  if (b.templateId && ['short-form', 'long-form'].includes(b.templateId)) return b.templateId;
  if (b.format === 'short') return 'short-form';
  if (b.format === 'long') return 'long-form';
  const ct = contentTypeStr || '';
  if (typeof ct === 'string' && ct.includes('-short')) return 'short-form';
  return 'long-form';
}

// All /v1/ routes require API key auth
router.use(requireApiKeyAuth);

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
  const b          = req.body || {};

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
      sourceConfig = b.sourceConfig || (b.url ? { urls: [b.url] } : {});
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

    const jobSpec = createJobSpec({
      customerId,
      planTier,
      templateId:   resolvedTemplateId,
      contentType:  resolvedContentType,
      sourceType,
      sourceConfig,
      stageMap:     stageMapOverride,
      addOns:       b.addOns       || {},
      durationMins: b.durationMins || (b.order?.duration ? parseInt(b.order.duration, 10) / 60 : 5),
    });

    jobSpec.productionProfile = productionProfile;

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
    if (orderFields.publish?.platforms?.length) {
      jobSpec.order.publish             = jobSpec.order.publish || {};
      jobSpec.order.publish.platforms   = orderFields.publish.platforms;
    }

    // staging: true — skip Portal 5 (publish) so output lands in R2 for human review.
    // Use GET /v1/jobs/:id/staging-assets to inspect, then POST /v1/jobs/:id/approve-publish to publish.
    if (b.staging === true) {
      jobSpec.staging = true;
      if (jobSpec.portals?.portal5) {
        jobSpec.portals.portal5.active = false;
        jobSpec.portals.portal5.reason = 'staging_mode — skipped for review before publish';
      }
    }

    const { creditCost } = calculateCreditCost({
      planTier,
      durationMins: jobSpec.durationMins || 5,
      sourceType:   jobSpec.sourceType,
      addOns:       jobSpec.addOns,
      contentType:  jobSpec.contentType,
    });

    if (creditCost > 0) {
      const creditResult = await consumeCredits(customerId, jobSpec.jobId, creditCost);
      if (creditResult.status === 'PAUSED' || creditResult.status === 'INSUFFICIENT') {
        return res.status(402).json({
          error: 'insufficient_credits',
          message: 'Insufficient credits. Purchase a pack to continue.',
          creditCost,
          balance: creditResult.balance || 0,
        });
      }
    }

    await db.updateJobSpec(jobSpec.jobId, jobSpec);

    // Fire-and-forget portal sequence
    const _jobId  = jobSpec.jobId;
    const _spec   = jobSpec; // captured reference — portals mutate this in place
    const _persist = (updates) => {
      Object.assign(_spec, updates);
      db.updateJobSpec(_jobId, _spec)
        .catch((e) => console.error('[v1] persistJobStatus updateJobSpec failed:', e.message));
      db.saveJob(_jobId, _spec)
        .catch((e) => console.error('[v1] persistJobStatus saveJob failed:', e.message));
    };

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
            await db.updateJobSpec(_jobId, _spec);
            console.log(`[v1] ${_jobId}: script generated (${_spec.filledScript?.length || 0} chars)`);
          } catch (scriptErr) {
            logError('CPD126_SCRIPT_GEN_FAILED', scriptErr, { jobId: _jobId });
            _persist({ status: 'failed', failedPortal: 'script_gen', updatedAt: new Date().toISOString() });
            return;
          }
        }

        // For topic-only jobs (no source video clips), mark video-dependent
        // portals inactive BEFORE runPortalSequence so resolveActivePortals
        // excludes them from the active portal list at startup.
        const _hasSourceClips = (
          (_spec.sourceConfig?.urls?.length > 0) ||
          (_spec.orderedClipUrls?.length > 0) ||
          (_spec.order?.inputs?.url) ||
          (_spec.order?.inputs?.items?.some((it) => it.url || it.videoUrl || it.clipUrl))
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
          };
          // Preserve output artifacts the portal wrote to _spec directly
          if (result.confirmedFormat) _spec.confirmedFormat = result.confirmedFormat;
          if (result.confirmedSources) _spec.confirmedSources = result.confirmedSources;
        };

        runPortalSequence({
          jobSpec: _spec,
          portalWorkers: workers,
          extensionWorkers: _resolveExtensionWorkers(),
          onPortalStart:  (pk) => {
            console.log(`[v1] ${_jobId}: portal ${pk} started`);
            _persist({ status: 'running', currentPortal: pk, updatedAt: new Date().toISOString() });
          },
          onPortalPass:   async (pk, result) => {
            console.log(`[v1] ${_jobId}: portal ${pk} passed`);
            _storeReport(pk, result);
            _persist({ status: 'running', currentPortal: pk, updatedAt: new Date().toISOString() });

            // After Portal 1 (script QA) passes, run assembly before Portal 3a needs assembledPath.
            // onPortalPass is awaited by runPortalSequence so this blocks the next portal.
            if (pk === 'portal1' && !_spec.assembledPath) {
              // Assembly only runs when source clips are present (topic-only jobs
              // had their video portals marked inactive before runPortalSequence).
              if (_hasSourceClips && !_spec.assembledPath) {
                try {
                  _persist({ status: 'running', currentPortal: 'assembly', updatedAt: new Date().toISOString() });
                  const { assembleForJob } = require('../assembly_service');
                  await assembleForJob(_spec);
                  await db.updateJobSpec(_jobId, _spec);
                  console.log(`[v1] ${_jobId}: assembly complete → ${_spec.assembledPath}`);
                } catch (asmErr) {
                  logError('CPD126_ASSEMBLY_FAILED', asmErr, { jobId: _jobId });
                  _persist({ status: 'failed', failedPortal: 'assembly', updatedAt: new Date().toISOString() });
                  throw asmErr; // surface to runPortalSequence .catch
                }
              }
            }
          },
          onPortalFail:   (pk, result) => {
            logError('CPD126_PORTAL_FAIL', result?.failReason || 'non-compliant', { jobId: _jobId, pk });
            _storeReport(pk, result);
            _persist({ status: 'non-compliant', currentPortal: pk, failedPortal: pk, updatedAt: new Date().toISOString() });
          },
          onJobComplete:  async (allResults) => {
            console.log(`[v1] ${_jobId}: pipeline complete`);
            Object.entries(allResults || {}).forEach(([pk, r]) => _storeReport(pk, r));
            // Directly await the final status write — prior fire-and-forget writes can race;
            // this ensures 'complete' is the last write guaranteed to land in the DB.
            Object.assign(_spec, { status: 'complete', updatedAt: new Date().toISOString() });
            try {
              await db.updateJobSpec(_jobId, _spec);
              await db.saveJob(_jobId, _spec);
            } catch (e) {
              console.error(`[v1] ${_jobId}: onJobComplete final persist failed:`, e.message);
            }
          },
          onJobFailed:    async (fp, result) => {
            logError('CPD126_JOB_FAILED', result?.failReason || fp, { jobId: _jobId });
            _storeReport(fp, result);
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
        });
      } catch (err) {
        logError('CPD126_PORTAL_START_FAIL', err, { jobId: _jobId });
        _persist({ status: 'failed', failedPortal: 'startup', updatedAt: new Date().toISOString() });
      }
    });

    res.status(202).json({
      jobId:       jobSpec.jobId,
      status:      'queued',
      staging:     jobSpec.staging || false,
      creditCost,
      planTier,
      createdAt:   new Date().toISOString(),
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
    let jobs = rows.slice(offset).map(_formatJob);
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
    res.json(_formatJob(row));
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

  try {
    const tpl = await db.createTemplate(req.user.id, {
      name, description: description || '',
      contentType: jobSpec.contentType || null,
      platforms:   jobSpec.order?.publish?.platforms || [],
      jobSpec,
      recurrenceType: null, recurrenceDay: null, recurrenceTime: null,
    });
    res.status(201).json({ template: tpl });
  } catch (err) {
    logError('CPD126_CREATE_TEMPLATE_FAIL', err);
    res.status(500).json({ error: 'create_template_failed' });
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
    // Reuse existing R2 presigned URL logic from upload route
    const { getUploadPresignedUrl } = require('../services/r2_upload');
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

// ─── GET /v1/account/api-keys ──────────────────────────────────────────────────
router.get('/account/api-keys', async (req, res) => {
  try {
    const keys = await listApiKeys(req.user.id);
    res.json({ apiKeys: keys });
  } catch (err) {
    res.status(500).json({ error: 'list_keys_failed' });
  }
});

// ─── POST /v1/account/api-keys ─────────────────────────────────────────────────
router.post('/account/api-keys', async (req, res) => {
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
router.delete('/account/api-keys/:keyId', async (req, res) => {
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

    // Trigger upload-post publish using the portal5 helper
    const { retryPlatformUpload, resolveUploadPostProfile } = require('../portals/portal5');
    const platforms = req.body.platforms || spec.order?.publish?.platforms || [];
    const profile = resolveUploadPostProfile(spec);

    if (!profile) {
      return res.status(422).json({
        error: 'no_upload_post_profile',
        message: 'No upload-post profile configured for this account. Set publishConfig.uploadPostProfile on the job spec or configure UPLOADPOST_PROFILE env var.',
      });
    }

    const results = {};
    for (const platform of platforms) {
      try {
        const r = await retryPlatformUpload(spec, platform);
        results[platform] = r;
      } catch (platformErr) {
        results[platform] = { failed: true, error: platformErr.message };
      }
    }

    // Mark as approved/published
    spec.staging   = false;
    spec.status    = 'published';
    spec.approvedAt = new Date().toISOString();
    spec.publishResults = results;
    await db.updateJobSpec(row.id, spec);

    res.json({ jobId: row.id, approved: true, platforms: results });
  } catch (err) {
    logError('CPD126_APPROVE_PUBLISH_FAIL', err);
    res.status(500).json({ error: 'approve_publish_failed', message: err.message });
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────────────
function _parseSpec(row) {
  if (!row.job_spec) return {};
  return typeof row.job_spec === 'string' ? JSON.parse(row.job_spec) : row.job_spec;
}

function _formatJob(row) {
  const spec = _parseSpec(row);
  return {
    jobId:        row.id,
    status:       spec.status || 'queued',
    entry:        spec.order?.inputs?.entry || null,
    productionProfile: spec.productionProfile || null,
    contentType:  spec.contentType || null,
    sourceType:   spec.sourceType  || null,
    planTier:     spec.planTier    || 'diy',
    topic:        spec.order?.topic    || null,
    tone:         spec.order?.tone     || null,
    format:       spec.order?.format   || null,
    platforms:    spec.order?.publish?.platforms || [],
    outputUrl:    spec.state?.savedOutputs?.r2VideoUrl || spec.assembledVideoUrl || null,
    filledScript: spec.filledScript || spec.scaffold || null,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at || row.created_at,
    portals:      _buildPortalSummary(spec),
  };
}

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
    // portal3b: mismatch_fixable passes through to portal4 per spec design
    portal3b: {
      ...(_adaptLegacyPortal(require('../portals/portal3b'), jobSpec)),
      isPass: (result) => result?.passed === true || result?.outcome === 'mismatch_fixable',
    },
    portal4:  _adaptLegacyPortal(require('../portals/portal4'),                jobSpec),
    portal5:  _adaptLegacyPortal(require('../portals/portal5'),                jobSpec),
  };
}

function _resolveExtensionWorkers() {
  return {
    heygen_ext:    require('../portals/portal_heygen_ext'),
    shoppable_ext: require('../portals/portal_shoppable_ext'),
  };
}

function _buildPortalSummary(spec) {
  const reports = spec.portalReports || spec.gateReports || {};
  return Object.entries(reports).map(([key, r]) => ({
    portal: key,
    passed: r.passed === true,
    status: r.policy?.status || (r.passed ? 'passed' : 'pending'),
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

module.exports = router;
