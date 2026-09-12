'use strict';
/**
 * Creator Stats API — post-publish performance for the active brand.
 *
 * GET /stats/summary
 * GET /stats/posts?limit=
 * GET /stats/youtube
 */

const router = require('express').Router();
const { requireAuth } = require('../auth');
const { resolveBrandContext } = require('../auth/brand_access');
const { buildStatsSummary, buildStatsPosts } = require('../stats');
const { fetchYoutubeLiteSummary } = require('../stats/adapters/youtube');

router.get('/stats/summary', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const customerId = req.user?.id || req.auth?.userId;
    const brandId = req.brandId;
    if (!customerId || !brandId) {
      return res.status(400).json({ ok: false, error: 'brand_required' });
    }
    const data = await buildStatsSummary(customerId, brandId);
    return res.json(data);
  } catch (err) {
    console.error('[stats/summary]', err.message);
    return res.status(500).json({ ok: false, error: err.message || 'stats_failed' });
  }
});

router.get('/stats/posts', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const customerId = req.user?.id || req.auth?.userId;
    const brandId = req.brandId;
    if (!customerId || !brandId) {
      return res.status(400).json({ ok: false, error: 'brand_required' });
    }
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const data = await buildStatsPosts(customerId, brandId, { limit });
    return res.json(data);
  } catch (err) {
    console.error('[stats/posts]', err.message);
    return res.status(500).json({ ok: false, error: err.message || 'stats_failed' });
  }
});

router.get('/stats/youtube', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const customerId = req.user?.id || req.auth?.userId;
    const brandId = req.brandId;
    if (!customerId || !brandId) {
      return res.status(400).json({ ok: false, error: 'brand_required' });
    }
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 28));
    const data = await fetchYoutubeLiteSummary(customerId, brandId, { days });
    return res.json(data);
  } catch (err) {
    console.error('[stats/youtube]', err.message);
    return res.status(500).json({ ok: false, error: err.message || 'stats_failed' });
  }
});

module.exports = router;
