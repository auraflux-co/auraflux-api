/**
 * lib/routes/templates.js — Job template CRUD (CPD-116)
 *
 * GET    /templates              — list customer's templates
 * POST   /templates              — create template
 * GET    /templates/:id          — get single template
 * PUT    /templates/:id          — update template name / recurrence
 * DELETE /templates/:id          — delete template
 * POST   /jobs/:jobId/save-as-template — snapshot a completed job as a template
 */

'use strict';

const express    = require('express');
const { requireAuth } = require('../auth');
const { resolveBrandContext } = require('../auth/brand_access');
const { apiLimit }    = require('../rateLimiter');
const {
  createTemplate,
  listTemplates,
  getTemplate,
  updateTemplate,
  deleteTemplate,
  loadJob,
} = require('../db');

const router = express.Router();

// ── List templates ────────────────────────────────────────────────────────────
router.get('/templates', requireAuth, resolveBrandContext, apiLimit, async (req, res) => {
  try {
    const rows = await listTemplates(req.user.id, req.brandId || null);
    res.json({ templates: rows.map(_serializeTemplate) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list templates', detail: err.message });
  }
});

// ── Get single template ───────────────────────────────────────────────────────
router.get('/templates/:id', requireAuth, apiLimit, async (req, res) => {
  try {
    const tpl = await getTemplate(req.params.id, req.user.id);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });
    res.json({ template: _serializeTemplate(tpl) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get template', detail: err.message });
  }
});

// ── Create template ───────────────────────────────────────────────────────────
router.post('/templates', requireAuth, resolveBrandContext, apiLimit, async (req, res) => {
  const { name, description, contentType, platforms, jobSpec,
          recurrenceType, recurrenceDay, recurrenceTime } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!jobSpec || typeof jobSpec !== 'object') {
    return res.status(400).json({ error: 'jobSpec is required' });
  }
  if (recurrenceType && !['once','daily','weekly','monthly'].includes(recurrenceType)) {
    return res.status(400).json({ error: 'recurrenceType must be once|daily|weekly|monthly' });
  }
  try {
    const tpl = await createTemplate(req.user.id, {
      name: name.trim(), description, contentType, platforms,
      jobSpec: _stripJobSpecForTemplate(jobSpec),
      recurrenceType, recurrenceDay, recurrenceTime,
      brandId: req.brandId || null,
    });
    res.status(201).json({ template: _serializeTemplate(tpl) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create template', detail: err.message });
  }
});

// ── Update template ───────────────────────────────────────────────────────────
router.put('/templates/:id', requireAuth, apiLimit, async (req, res) => {
  try {
    const tpl = await getTemplate(req.params.id, req.user.id);
    if (!tpl) return res.status(404).json({ error: 'Template not found' });

    const patch = {};
    const allowed = ['name','description','recurrence_type','recurrence_day',
                     'recurrence_time','recurrence_active'];
    for (const k of allowed) {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    }
    // Camel → snake for incoming camelCase fields
    if (req.body.recurrenceType  !== undefined) patch.recurrence_type   = req.body.recurrenceType;
    if (req.body.recurrenceDay   !== undefined) patch.recurrence_day    = req.body.recurrenceDay;
    if (req.body.recurrenceTime  !== undefined) patch.recurrence_time   = req.body.recurrenceTime;
    if (req.body.recurrenceActive !== undefined) patch.recurrence_active = req.body.recurrenceActive;

    const recType  = patch.recurrence_type ?? tpl.recurrence_type;
    const recDay   = patch.recurrence_day  ?? tpl.recurrence_day;
    const recTime  = patch.recurrence_time ?? tpl.recurrence_time;
    if (req.body.recurrenceType !== undefined || req.body.recurrenceDay !== undefined
        || req.body.recurrenceTime !== undefined || req.body.recurrenceActive !== undefined) {
      const { computeNextFireAt } = require('../db');
      if (recType && recType !== 'once' && recTime) {
        patch.next_fire_at = computeNextFireAt(recType, recDay, recTime);
        if (patch.recurrence_active === undefined && req.body.recurrenceActive === undefined) {
          patch.recurrence_active = true;
        }
      } else if (recType === 'once' || !recType) {
        patch.next_fire_at = null;
        patch.recurrence_active = false;
      }
    }

    const updated = await updateTemplate(req.params.id, req.user.id, patch);
    res.json({ template: _serializeTemplate(updated) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update template', detail: err.message });
  }
});

// ── Delete template ───────────────────────────────────────────────────────────
router.delete('/templates/:id', requireAuth, apiLimit, async (req, res) => {
  try {
    const deleted = await deleteTemplate(req.params.id, req.user.id);
    if (!deleted) return res.status(404).json({ error: 'Template not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete template', detail: err.message });
  }
});

// ── Save completed job as template ────────────────────────────────────────────
router.post('/jobs/:jobId/save-as-template', requireAuth, resolveBrandContext, apiLimit, async (req, res) => {
  const { name, description, recurrenceType, recurrenceDay, recurrenceTime } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const jobSpec = loadJob(req.params.jobId);
    if (!jobSpec) return res.status(404).json({ error: 'Job not found' });
    if (jobSpec.customerId && jobSpec.customerId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const tpl = await createTemplate(req.user.id, {
      name: name.trim(), description,
      contentType: jobSpec.order?.contentType || jobSpec.contentType,
      platforms: jobSpec.platforms || jobSpec.order?.platforms || [],
      jobSpec: _stripJobSpecForTemplate(jobSpec),
      recurrenceType, recurrenceDay, recurrenceTime,
      brandId: req.brandId || jobSpec.brandId || null,
    });
    res.status(201).json({ template: _serializeTemplate(tpl) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save template', detail: err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// Remove job-run-specific fields before storing as reusable template.
function _stripJobSpecForTemplate(spec) {
  const strip = ['jobId','customerId','status','createdAt','updatedAt','completedAt',
                 'state','portalReports','outputUrl','thumbnailUrl','publishResults',
                 'failureReason','creditLedgerId','assembledPath'];
  const out = { ...spec };
  for (const k of strip) delete out[k];
  return out;
}

function _serializeTemplate(row) {
  if (!row) return null;
  return {
    id:               row.id,
    brandId:          row.brand_id || null,
    name:             row.name,
    description:      row.description,
    contentType:      row.content_type,
    platforms:        row.platforms || [],
    jobSpec:          typeof row.job_spec === 'string' ? JSON.parse(row.job_spec) : row.job_spec,
    recurrenceType:   row.recurrence_type,
    recurrenceDay:    row.recurrence_day,
    recurrenceTime:   row.recurrence_time,
    recurrenceActive: row.recurrence_active,
    nextFireAt:       row.next_fire_at,
    lastFiredAt:      row.last_fired_at,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
  };
}

module.exports = router;
