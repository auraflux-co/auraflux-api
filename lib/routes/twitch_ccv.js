'use strict';
/**
 * lib/routes/twitch_ccv.js — Customer Twitch CCV peaks API
 *
 * GET /twitch-ccv/peaks          — recent streams + peaks for active brand
 * GET /twitch-ccv/peaks/:id      — one stream + sample series (demo chart)
 * POST /twitch-ccv/poll          — operator/admin force poll (optional)
 */

const router = require('express').Router();
const { requireAuth } = require('../auth');
const { resolveBrandContext } = require('../auth/brand_access');
const {
  listPeaksForBrand,
  getSampleSeries,
  pollOnce,
} = require('../twitch_ccv');
const { query: dbQuery } = require('../db/postgres');

router.get('/twitch-ccv/peaks', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const brandId = req.brandId || null;
    let login = null;
    if (brandId) {
      const ch = await dbQuery(
        `SELECT source_channels->>'twitchLogin' AS twitch_login
           FROM client_plans
          WHERE brand_id = $1 AND active = TRUE
          LIMIT 1`,
        [brandId],
      );
      login = ch.rows[0]?.twitch_login || null;
    }
    const peaks = await listPeaksForBrand({
      brandId,
      twitchLogin: login,
      limit: Number(req.query.limit) || 10,
    });
    res.json({
      ok: true,
      brandId,
      twitchLogin: login,
      peaks,
      hint: peaks.length
        ? 'Peak CCV is captured while you are live. Open the VOD at peakClock to trim.'
        : 'Save your Twitch channel, then go live once — we record peak concurrent viewers and link the VOD.',
    });
  } catch (err) {
    console.error('[twitch-ccv] peaks list failed:', err.message);
    res.status(500).json({ ok: false, error: err.message || 'peaks_failed' });
  }
});

router.get('/twitch-ccv/peaks/:id', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const brandId = req.brandId || null;
    const peakRows = await listPeaksForBrand({ brandId, limit: 50 });
    const peak = peakRows.find((p) => p.id === req.params.id);
    if (!peak) {
      // Allow lookup by id if owned via login on brand
      const byId = await dbQuery(
        `SELECT id, brand_id, twitch_login FROM twitch_ccv_streams WHERE id = $1`,
        [req.params.id],
      );
      const row = byId.rows[0];
      if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
      if (brandId && row.brand_id && row.brand_id !== brandId) {
        return res.status(403).json({ ok: false, error: 'forbidden' });
      }
    }
    const streamId = peak?.id || req.params.id;
    const series = await getSampleSeries(streamId);
    const detail = peak || (await listPeaksForBrand({ brandId, limit: 50 }))
      .find((p) => p.id === streamId);
    res.json({ ok: true, peak: detail || { id: streamId }, series });
  } catch (err) {
    console.error('[twitch-ccv] peak detail failed:', err.message);
    res.status(500).json({ ok: false, error: err.message || 'peak_detail_failed' });
  }
});

router.post('/twitch-ccv/poll', requireAuth, async (req, res) => {
  try {
    const role = req.user?.role || 'customer';
    if (!['admin', 'operator', 'owner'].includes(role) && process.env.NODE_ENV === 'production') {
      return res.status(403).json({ ok: false, error: 'admin_only' });
    }
    const result = await pollOnce();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'poll_failed' });
  }
});

module.exports = router;
