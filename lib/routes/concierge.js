'use strict';
/**
 * lib/routes/concierge.js — CPD-83: AI Concierge backend routes
 *
 * Routes:
 *   GET  /concierge/portal-contracts  — structured gate requirements (public within auth)
 *   POST /concierge/validate          — per-portal validation of a job spec
 *   POST /concierge/chat              — Gemini-powered guided assistant response
 *
 * Auth: customer+ role required on all routes.
 */

'use strict';

const router = require('express').Router();
const { requireAuth, requireRole, ROLES } = require('../auth');
const { apiLimit } = require('../rateLimiter');
const {
  getPortalContracts,
  validateJobSpec,
  chatWithConcierge,
} = require('../services/concierge');
const { isFeatureEnabled } = require('../services/feature_gate');

// ─── Middleware shorthand ─────────────────────────────────────────────────────

const auth = [requireAuth, requireRole(ROLES.CUSTOMER)];

// ─── GET /concierge/portal-contracts ──────────────────────────────────────────
// Returns the complete portal contract definitions — required fields, format
// rules, limits for every portal stage. Used by UI to show requirements and
// by the Gemini system prompt to understand what it needs to validate.

router.get('/concierge/portal-contracts', auth, (req, res) => {
  const contracts = getPortalContracts();
  res.json({ ok: true, contracts });
});

// ─── POST /concierge/validate ──────────────────────────────────────────────────
// Accepts a partial or complete job spec. Returns per-portal pass/fail with
// missing fields and specific fix suggestions.
//
// Body: { spec: object }
// Returns: { ok, overall, readyPortals, blockedPortals, portals[] }

router.post('/concierge/validate', auth, apiLimit, (req, res) => {
  const { spec = {} } = req.body || {};

  if (typeof spec !== 'object' || Array.isArray(spec)) {
    return res.status(400).json({ ok: false, error: 'spec must be an object', label: 'INVALID_SPEC' });
  }

  const result = validateJobSpec(spec);
  return res.json({ ok: true, ...result });
});

// ─── POST /concierge/chat ──────────────────────────────────────────────────────
// Accepts a conversation history and current job spec state. Calls Gemini
// with the full portal contract system prompt. Returns the assistant response.
//
// Body: { messages: [{role, content}], spec?: object, planTier?: string, customerId?: string }
// Returns: { ok, response: string }

router.post('/concierge/chat', auth, apiLimit, async (req, res) => {
  const { messages = [], spec = {}, planTier, customerId } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ ok: false, error: 'messages must be a non-empty array', label: 'INVALID_MESSAGES' });
  }

  // Gate: concierge requires diy plan or higher (Operate = guide mode, Guided/Managed = full)
  const resolvedPlan = planTier || req.user?.planTier || 'operate';
  if (!isFeatureEnabled('concierge', resolvedPlan)) {
    return res.status(403).json({
      ok:    false,
      error: `AI Concierge requires a Standard (dwy) plan or higher. Current plan: ${resolvedPlan}`,
      label: 'PLAN_GATE',
    });
  }

  // Validate message shape
  for (const msg of messages) {
    if (!msg.role || !msg.content || !['user', 'assistant'].includes(msg.role)) {
      return res.status(400).json({
        ok:    false,
        error: 'Each message must have role ("user" or "assistant") and content (string)',
        label: 'INVALID_MESSAGE_SHAPE',
      });
    }
  }

  try {
    const response = await chatWithConcierge(messages, spec, { planTier: resolvedPlan, customerId });
    return res.json({ ok: true, response });
  } catch (err) {
    const label = err.message.includes('plan') ? 'PLAN_GATE'
      : err.message.includes('API_KEY')         ? 'GEMINI_NOT_CONFIGURED'
      : 'CONCIERGE_ERROR';
    const status = label === 'PLAN_GATE' ? 403 : label === 'GEMINI_NOT_CONFIGURED' ? 503 : 500;
    return res.status(status).json({ ok: false, error: err.message, label });
  }
});

// ── POST /concierge/schedule-suggest — CPD-121/122/123 ───────────────────────
router.post('/concierge/schedule-suggest', auth, apiLimit, async (req, res) => {
  const { templates = [], platforms = [], goals = '', days = 30 } = req.body;
  try {
    const { suggestSchedule } = require('../services/concierge');
    const suggestion = await suggestSchedule({
      planTier:  req.user.planTier || 'operate',
      templates,
      platforms,
      goals,
      days: Math.min(Number(days) || 30, 90),
    });
    return res.json({ ok: true, suggestion });
  } catch (err) {
    const label = err.message.includes('plan') ? 'PLAN_GATE'
      : err.message.includes('API_KEY')        ? 'GEMINI_NOT_CONFIGURED'
      : 'SUGGEST_ERROR';
    const status = label === 'PLAN_GATE' ? 403 : label === 'GEMINI_NOT_CONFIGURED' ? 503 : 500;
    return res.status(status).json({ ok: false, error: err.message, label });
  }
});

module.exports = router;
