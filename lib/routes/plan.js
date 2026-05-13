'use strict';
/**
 * lib/routes/plan.js — Plan feature matrix API (CPD-84)
 *
 * GET /plan/features
 *   Returns all platform features with enabled/disabled status for the caller's
 *   plan tier. Used by the dashboard plan comparison UI and the AI Concierge.
 *
 * GET /plan/features/matrix
 *   Returns the full plan × feature matrix (all tiers), for use by the
 *   pricing page or admin tools.
 */

const router = require('express').Router();
const { requireAuth } = require('../auth');
const { getPlanFeatureMatrix, FEATURE_PLANS, isFeatureEnabled, TIER_RANK } = require('../services/feature_gate');

// GET /plan/features — caller's plan tier
router.get('/plan/features', requireAuth, (req, res) => {
  const planTier = req.user?.planTier || 'operate';
  const matrix = getPlanFeatureMatrix(planTier);
  return res.json({ ok: true, planTier, features: matrix });
});

// GET /plan/features/matrix — all tiers × all features (operator/admin only)
router.get('/plan/features/matrix', requireAuth, (req, res) => {
  const tiers = Object.keys(TIER_RANK).filter((t) => t !== 'custom').concat(['custom']);
  const features = {};

  for (const [key, def] of Object.entries(FEATURE_PLANS)) {
    features[key] = {
      label:       def.label,
      description: def.description,
      min_plan:    def.min_plan,
      plans:       Object.fromEntries(tiers.map((t) => [t, isFeatureEnabled(key, t)])),
    };
  }

  return res.json({ ok: true, features });
});

module.exports = router;
