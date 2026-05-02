'use strict';
/**
 * lib/routes/developer_api.js — CPD-126: Developer API for Operate plan customers
 *
 * Mounted at /v1/ in server.js.
 * Auth: Authorization: Bearer af_live_<key>  (lib/auth/api_key.js)
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
 *   GET    /v1/account                — credits, plan tier, rate limits
 *   GET    /v1/account/api-keys       — list API keys
 *   POST   /v1/account/api-keys       — create API key
 *   DELETE /v1/account/api-keys/:keyId — revoke API key
 */

const express   = require('express');
const { requireApiKeyAuth }  = require('../auth/api_key');
const { createJobSpec }      = require('../job_spec');
const { estimateCreditCost } = require('../services/credit_calculator');
const { consumeCredits, getCredits } = require('../services/credits');
const { createApiKey, listApiKeys, revokeApiKey } = require('../services/api_keys');
const { isFeatureEnabled }   = require('../services/feature_gate');
const { logError }           = require('../error_logger');
const db                     = require('../db/postgres');

const router = express.Router();

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
    const jobSpec = createJobSpec({
      customerId,
      planTier,
      contentType:  b.contentType  || 'news',
      sourceType:   b.sourceType   || 'url_list',
      sourceConfig: b.sourceConfig || {},
      order:        b.order        || {},
      stageMap:     b.stageMap     || {},
      addOns:       b.addOns       || {},
      durationMins: b.durationMins || 5,
    });

    const { creditCost } = estimateCreditCost({
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

    await db.persistJobSpec(jobSpec);

    // Fire-and-forget portal sequence
    setImmediate(async () => {
      try {
        const { runPortalSequence } = require('../portal_policy_runner');
        await runPortalSequence({ jobSpec, jobId: jobSpec.jobId });
      } catch (err) {
        logError('CPD126_PORTAL_START_FAIL', err, { jobId: jobSpec.jobId });
      }
    });

    res.status(202).json({
      jobId:       jobSpec.jobId,
      status:      'queued',
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
    const row = await db.getJobRow(req.params.id);
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
    const row = await db.getJobRow(req.params.id);
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
    const row = await db.getJobRow(req.params.id);
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
    const row = await db.getJobRow(req.params.id);
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
    const credits = await getCredits(req.user.id);
    const RATE_LIMITS = { diy: { rpm: 60, concurrent: 3 }, dwy: { rpm: 120, concurrent: 10 }, dfy: { rpm: 300, concurrent: null } };
    const limits  = RATE_LIMITS[req.user.planTier] || RATE_LIMITS.diy;

    res.json({
      customerId: req.user.id,
      email:      req.user.email,
      planTier:   req.user.planTier,
      credits:    { balance: credits?.balance || 0, used: credits?.used || 0 },
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

// ─── Helpers ───────────────────────────────────────────────────────────────────
function _parseSpec(row) {
  if (!row.job_spec) return {};
  return typeof row.job_spec === 'string' ? JSON.parse(row.job_spec) : row.job_spec;
}

function _formatJob(row) {
  const spec = _parseSpec(row);
  return {
    jobId:       row.id,
    status:      spec.status || 'queued',
    contentType: spec.contentType || null,
    sourceType:  spec.sourceType  || null,
    planTier:    spec.planTier    || 'diy',
    platforms:   spec.order?.publish?.platforms || [],
    outputUrl:   spec.state?.savedOutputs?.r2VideoUrl || null,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at || row.created_at,
    portals:     _buildPortalSummary(spec),
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

module.exports = router;
