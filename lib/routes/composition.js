'use strict';

/**
 * Composition near-final preview routes — graduated from C0 (iss_tY3Ii28wvWBK).
 * Growth Peaks path: POST timeline-preview + GET preview file.
 * Deliberately omits C0 operator chrome (templates, moment-finder, EXECUTE, FCPXML).
 */

const fs = require('fs');
const path = require('path');
const router = require('express').Router();
const { requireAuth } = require('../auth');
const { isFeatureEnabled } = require('../services/feature_gate');
const {
  renderCompositionTimelinePreview,
  cleanupOldPreviews,
  PREVIEW_DIR,
} = require('../composition_preview');

function planTierFromReq(req) {
  return req.user?.planTier || req.user?.plan_tier || 'operate';
}

function requireNearFinalPreview(req, res, next) {
  const tier = planTierFromReq(req);
  if (!isFeatureEnabled('composition.near_final_preview', tier)) {
    return res.status(403).json({
      ok: false,
      error: 'feature_gated',
      feature: 'composition.near_final_preview',
      planTier: tier,
    });
  }
  return next();
}

/** Public scrub — filenames are unguessable timestamps; cleaned on age. Auth on POST only. */
router.get('/composition/preview/file/:name', (req, res) => {
  try {
    const name = path.basename(req.params.name || '');
    const isJpeg = /^prev_[\w.-]+\.jpg$/.test(name) || /^tlprev_[\w.-]+\.jpg$/.test(name);
    const isMp4 = /^prev_[\w.-]+\.mp4$/.test(name) || /^tlprev_[\w.-]+\.mp4$/.test(name);
    if (!isJpeg && !isMp4) {
      return res.status(400).json({ ok: false, error: 'Invalid preview file' });
    }
    const filePath = path.join(PREVIEW_DIR, name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, error: 'Not found' });
    res.setHeader('Content-Type', isMp4 ? 'video/mp4' : 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    if (isMp4) res.setHeader('Accept-Ranges', 'bytes');
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Burn near-final preview for a staged R2 clip (Peaks → Review → Short).
 * Body: { clip: { mp4Url|stagedUrl|url, trimStart?, trimEnd?, title? }, compCreativePreset?, compCreative? }
 */
router.post('/composition/timeline-preview', requireAuth, requireNearFinalPreview, async (req, res) => {
  cleanupOldPreviews();
  const body = req.body || {};
  const log = (m) => console.log(m);
  try {
    const preset = body.compCreativePreset || 'classic_blur_pad';
    const overrides = body.compCreative || {};
    const deliveryAspect = body.deliveryAspect === '1:1' ? '1:1' : '9:16';
    const clips = Array.isArray(body.clips) ? body.clips : [];
    let clip = body.clip || clips[0] || null;
    if (clip && !clip.url && !clip.pageUrl && !clip.mp4Url && !clip.stagedUrl && !clip.resolvedMp4) {
      clip = null;
    }
    if (!clip) {
      return res.status(400).json({ ok: false, error: 'clip with mp4Url/stagedUrl required' });
    }
    // Peaks already trimmed on device — avoid re-trim unless caller sent window.
    if (clip.mp4Url || clip.stagedUrl || clip.resolvedMp4) {
      clip = {
        ...clip,
        resolvedMp4: clip.resolvedMp4 || clip.mp4Url || clip.stagedUrl,
        url: clip.url || clip.mp4Url || clip.stagedUrl,
        pageUrl: clip.pageUrl || clip.url || clip.mp4Url || clip.stagedUrl,
        trimStart: clip.trimStart != null ? Number(clip.trimStart) : 0,
        trimEnd: clip.trimEnd != null ? Number(clip.trimEnd) : (clip.duration || undefined),
      };
    }
    const result = await renderCompositionTimelinePreview({
      clip,
      compCreativePreset: preset,
      compCreativeOverrides: overrides,
      deliveryAspect,
      twitchClient: null,
      log,
    });
    const apiBase = (process.env.PUBLIC_API_BASE || process.env.API_PUBLIC_URL || '').replace(/\/$/, '');
    if (result.previewVideoUrl && apiBase && result.previewVideoUrl.startsWith('/')) {
      result.previewVideoAbsoluteUrl = `${apiBase}${result.previewVideoUrl}`;
    }
    if (result.previewUrl && apiBase && result.previewUrl.startsWith('/')) {
      result.previewAbsoluteUrl = `${apiBase}${result.previewUrl}`;
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[composition/timeline-preview]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
