'use strict';

/**
 * Guest review share + sponsor scan + playlist strategy match routes.
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requireRole, ROLES } = require('../auth');
const { loadJob, saveJob } = require('../db');
const { isFeatureEnabled } = require('../services/feature_gate');
const { createReviewShareToken, resolveReviewShareToken } = require('../services/review_share');
const { detectSponsorMarkers, adjustBoundariesForSponsors, buildSponsorLowerThird } = require('../services/sponsor_markers');
const { matchPlaylistStrategy } = require('../services/playlist_strategy');
const { getBrand } = require('../db/postgres');
const { logError } = require('../error_logger');

const APP_BASE = (process.env.NEXT_PUBLIC_APP_URL || process.env.AURAFLUX_APP_URL || 'https://app.auraflux.co').replace(/\/$/, '');

function planFrom(req, jobSpec) {
  return req.user?.planTier || jobSpec?.planTier || 'operate';
}

// ── Auth: create share link ───────────────────────────────────────────────────

router.post(
  '/jobs/:jobId/review-share',
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    try {
      const { jobId } = req.params;
      const jobSpec = await loadJob(jobId);
      if (!jobSpec) return res.status(404).json({ ok: false, error: 'Job not found' });
      if (!isFeatureEnabled('review.guest_share', planFrom(req, jobSpec))) {
        return res.status(403).json({ ok: false, error: 'feature_gated', feature: 'review.guest_share' });
      }
      const ttlDays = Math.min(30, Math.max(1, Number(req.body?.ttlDays) || 7));
      const share = await createReviewShareToken({
        jobId,
        brandId: jobSpec.brandId || null,
        accountId: req.user.id,
        ttlDays,
      });
      res.json({
        ok: true,
        token: share.token,
        urlPath: share.urlPath,
        url: `${APP_BASE}${share.urlPath}`,
        expiresAt: share.expiresAt,
      });
    } catch (e) {
      logError('REVIEW_SHARE_CREATE_FAIL', e, { jobId: req.params.jobId });
      res.status(500).json({ ok: false, error: e.message });
    }
  },
);

// ── Public: resolve share payload ─────────────────────────────────────────────

router.get('/public/review-share/:token', async (req, res) => {
  try {
    const row = await resolveReviewShareToken(req.params.token);
    if (!row) return res.status(404).json({ ok: false, error: 'invalid_or_expired' });
    const jobSpec = await loadJob(row.job_id);
    if (!jobSpec) return res.status(404).json({ ok: false, error: 'job_missing' });

    const assets = jobSpec.state?.savedOutputs || {};
    const videoUrl = assets.r2VideoUrl || assets.signedUrl || assets.assembledVideoUrl || null;
    const thumbUrl = jobSpec.state?.thumbnail?.r2Url || assets.thumbnailUrl || null;

    res.json({
      ok: true,
      jobId: row.job_id,
      permissions: row.permissions || {},
      expiresAt: row.expires_at,
      title: jobSpec.topic || jobSpec.order?.topic || jobSpec.jobId,
      videoUrl,
      thumbnailUrl: thumbUrl,
      captionsEnabled: jobSpec.featureConfig?.captions !== false,
      audioBed: jobSpec.featureConfig?.compose?.audioBed
        || jobSpec.designSpec?.compCreative?.audio?.musicBed
        || null,
      status: jobSpec.status,
    });
  } catch (e) {
    logError('REVIEW_SHARE_GET_FAIL', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/public/review-share/:token/approve', async (req, res) => {
  try {
    const row = await resolveReviewShareToken(req.params.token);
    if (!row) return res.status(404).json({ ok: false, error: 'invalid_or_expired' });
    if (row.permissions && row.permissions.approve === false) {
      return res.status(403).json({ ok: false, error: 'approve_not_allowed' });
    }
    // Delegate to same path as member approve — mark staging approved flag
    const jobSpec = await loadJob(row.job_id);
    if (!jobSpec) return res.status(404).json({ ok: false, error: 'job_missing' });
    if (!jobSpec.state) jobSpec.state = {};
    jobSpec.state.guestReview = {
      ...(jobSpec.state.guestReview || {}),
      approvedAt: new Date().toISOString(),
      via: 'share_token',
    };
    jobSpec.status = jobSpec.status === 'operator_review' || jobSpec.status === 'staged'
      ? 'approved_for_publish'
      : jobSpec.status;
    await saveJob(jobSpec);

    // Best-effort: invoke approve-publish handler logic if exported — else flag only
    try {
      const { triggerApprovePublish } = require('../services/approve_publish');
      if (typeof triggerApprovePublish === 'function') {
        await triggerApprovePublish(jobSpec, { source: 'guest_share' });
      }
    } catch (_) { /* optional helper */ }

    res.json({ ok: true, status: jobSpec.status, guestReview: jobSpec.state.guestReview });
  } catch (e) {
    logError('REVIEW_SHARE_APPROVE_FAIL', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/public/review-share/:token/revise', async (req, res) => {
  try {
    const row = await resolveReviewShareToken(req.params.token);
    if (!row) return res.status(404).json({ ok: false, error: 'invalid_or_expired' });
    if (row.permissions && row.permissions.revise === false) {
      return res.status(403).json({ ok: false, error: 'revise_not_allowed' });
    }
    const comment = String(req.body?.comment || req.body?.feedback || '').slice(0, 4000);
    const categories = Array.isArray(req.body?.categories) ? req.body.categories : [];
    const jobSpec = await loadJob(row.job_id);
    if (!jobSpec) return res.status(404).json({ ok: false, error: 'job_missing' });

    try {
      const { ingestRevisionFeedback } = require('../services/revision_directive');
      await ingestRevisionFeedback(jobSpec, {
        feedback: comment,
        categories,
        source: 'guest_share',
      });
    } catch (e) {
      if (!jobSpec.state) jobSpec.state = {};
      jobSpec.state.guestReview = {
        ...(jobSpec.state.guestReview || {}),
        reviseRequestedAt: new Date().toISOString(),
        comment,
        categories,
      };
      jobSpec.status = 'revision_requested';
      await saveJob(jobSpec);
    }

    res.json({ ok: true, status: 'revision_requested' });
  } catch (e) {
    logError('REVIEW_SHARE_REVISE_FAIL', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/public/review-share/:token/comment', async (req, res) => {
  try {
    const row = await resolveReviewShareToken(req.params.token);
    if (!row) return res.status(404).json({ ok: false, error: 'invalid_or_expired' });
    if (row.permissions && row.permissions.comment === false) {
      return res.status(403).json({ ok: false, error: 'comment_not_allowed' });
    }
    const text = String(req.body?.comment || '').slice(0, 2000);
    if (!text) return res.status(400).json({ ok: false, error: 'comment_required' });
    const jobSpec = await loadJob(row.job_id);
    if (!jobSpec) return res.status(404).json({ ok: false, error: 'job_missing' });
    if (!jobSpec.state) jobSpec.state = {};
    const comments = Array.isArray(jobSpec.state.guestComments) ? jobSpec.state.guestComments : [];
    comments.push({ at: new Date().toISOString(), text, via: 'share_token' });
    jobSpec.state.guestComments = comments.slice(-50);
    await saveJob(jobSpec);
    res.json({ ok: true, count: jobSpec.state.guestComments.length });
  } catch (e) {
    logError('REVIEW_SHARE_COMMENT_FAIL', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Sponsor scan ──────────────────────────────────────────────────────────────

router.post(
  '/jobs/:jobId/sponsor-scan',
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    try {
      const jobSpec = await loadJob(req.params.jobId);
      if (!jobSpec) return res.status(404).json({ ok: false, error: 'Job not found' });
      if (!isFeatureEnabled('sponsor.markers', planFrom(req, jobSpec))) {
        return res.status(403).json({ ok: false, error: 'feature_gated' });
      }
      const transcript = jobSpec.state?.savedOutputs?.transcript
        || jobSpec.state?.transcript
        || req.body?.transcript
        || null;
      const markers = detectSponsorMarkers(transcript);
      const trimStart = req.body?.trimStart ?? jobSpec.featureConfig?.peakStartSec;
      const trimEnd = req.body?.trimEnd ?? jobSpec.featureConfig?.peakEndSec;
      let boundaries = null;
      if (trimStart != null && trimEnd != null) {
        boundaries = adjustBoundariesForSponsors(Number(trimStart), Number(trimEnd), markers);
      }
      const appendOverlay = !!req.body?.appendSponsorOverlay;
      let lowerThird = null;
      if (appendOverlay) {
        lowerThird = buildSponsorLowerThird(markers, req.body?.brandName || null);
        if (lowerThird) {
          if (!jobSpec.addOns) jobSpec.addOns = {};
          if (!jobSpec.addOns.lower_thirds) jobSpec.addOns.lower_thirds = { active: true, items: [] };
          jobSpec.addOns.lower_thirds.active = true;
          jobSpec.addOns.lower_thirds.items = [
            ...(jobSpec.addOns.lower_thirds.items || []).filter((i) => i.style !== 'sponsor'),
            lowerThird,
          ];
          await saveJob(jobSpec);
        }
      }
      if (!jobSpec.state) jobSpec.state = {};
      jobSpec.state.sponsorMarkers = markers;
      if (boundaries?.adjusted) jobSpec.state.sponsorBoundaryAdjust = boundaries;
      await saveJob(jobSpec);
      res.json({ ok: true, markers, boundaries, lowerThird });
    } catch (e) {
      logError('SPONSOR_SCAN_FAIL', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  },
);

// ── Playlist strategy match ───────────────────────────────────────────────────

router.get(
  '/jobs/:jobId/playlist-strategy',
  requireAuth,
  requireRole({ minLevel: ROLES.CUSTOMER }),
  async (req, res) => {
    try {
      const jobSpec = await loadJob(req.params.jobId);
      if (!jobSpec) return res.status(404).json({ ok: false, error: 'Job not found' });
      if (!isFeatureEnabled('publish.playlist_strategy', planFrom(req, jobSpec))) {
        return res.json({ ok: true, matched: false, gated: true });
      }
      let rules = [];
      if (jobSpec.brandId && req.user?.id) {
        try {
          const brand = await getBrand(jobSpec.brandId, req.user.id);
          rules = brand?.publish_strategy_rules || [];
          if (typeof rules === 'string') rules = JSON.parse(rules);
        } catch (_) { /* ignore */ }
      }
      const tags = [
        ...(jobSpec.tags || []),
        ...(jobSpec.order?.tags || []),
        jobSpec.featureConfig?.compose?.preset,
      ].filter(Boolean);
      const audioBed = jobSpec.designSpec?.compCreative?.audio?.musicBed
        || jobSpec.featureConfig?.compose?.audioBed
        || null;
      const match = matchPlaylistStrategy(rules, {
        tags,
        audioBed,
        platform: String(req.query.platform || 'youtube'),
      });
      res.json({ ok: true, ...match });
    } catch (e) {
      logError('PLAYLIST_STRATEGY_FAIL', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  },
);

module.exports = router;
