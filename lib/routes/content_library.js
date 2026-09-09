'use strict';
/**
 * Customer Peaks API — YouTube Most Replayed → stage trim window.
 *
 * GET  /content-library/vods
 * POST /content-library/vod/analyze
 * GET  /content-library/vod/:sessionId/segments
 * POST /content-library/stage-vod-window
 * GET  /content-library/presets
 */

const router = require('express').Router();
const { requireAuth } = require('../auth');
const { resolveBrandContext } = require('../auth/brand_access');
const { query: dbQuery } = require('../db/postgres');
const { analyzeVodHighlights, getVodSegments } = require('../content_library/vod_highlights');
const { stageVodWindowToR2 } = require('../content_library/stage_vod_window');
const { isYoutubeUrl, extractYoutubeVideoId } = require('../content_library/youtube_heatmap');

/** Compose presets we advertise (C1–C11 labels). Assembly creative parity lands next. */
const COMPOSE_PRESETS = [
  { code: 'C1', key: 'classic_blur_pad', label: 'Classic ClipzWorld' },
  { code: 'C2', key: 'full_bleed', label: 'Full Bleed' },
  { code: 'C3', key: 'serpent_ranked', label: 'Serpent Ranked Short' },
  { code: 'C4', key: 'serpent_ranked_vod', label: 'Serpent Ranked VOD' },
  { code: 'C5', key: 'dahbluh_clean', label: 'DahBluh Clean' },
  { code: 'C6', key: 'twitch_comp_vod', label: 'Comp VOD Edited' },
  { code: 'C7', key: 'custom', label: 'Custom Advanced' },
  { code: 'C8', key: 'facecam_split', label: 'Facecam Split' },
  { code: 'C9', key: 'fableflow_speed', label: 'FableFlow Speed' },
  { code: 'C10', key: 'reaction_short', label: 'Reaction Short' },
  { code: 'C11', key: 'dual_source_stack', label: 'Then/Now Stack' },
];

async function resolveBrandYoutubeHandle(brandId) {
  if (!brandId) return null;
  const result = await dbQuery(
    `SELECT source_channels->>'youtubeHandle' AS handle
       FROM client_plans
      WHERE brand_id = $1 AND active = TRUE
      LIMIT 1`,
    [brandId],
  );
  return result.rows[0]?.handle || null;
}

router.get('/content-library/presets', requireAuth, (_req, res) => {
  res.json({ ok: true, presets: COMPOSE_PRESETS });
});

router.get('/content-library/vods', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const YouTubeClient = require('../clients/youtube_client');
    const client = new YouTubeClient();
    let handle = String(req.query.handle || req.query.streamer || '').trim();
    if (!handle) handle = (await resolveBrandYoutubeHandle(req.brandId)) || '';
    if (!handle) {
      return res.status(400).json({
        ok: false,
        error: 'youtube_handle_required',
        hint: 'Connect a YouTube handle under My Channels, or pass ?handle=@channel',
      });
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const channel = await client.getChannelByHandle(handle);
    if (!channel?.id) {
      return res.status(404).json({ ok: false, error: 'channel_not_found', handle });
    }
    const videos = await client.getRecentVideos(channel.id, limit);
    const vods = (videos || [])
      .filter((v) => !v.isShort && (v.duration || 0) >= 180)
      .map((v) => ({
        platform: 'youtube',
        streamer: handle.replace(/^@/, '').toLowerCase(),
        vodId: v.id,
        title: v.title,
        url: v.url || `https://www.youtube.com/watch?v=${v.id}`,
        thumbnailUrl: v.thumbnailUrl,
        duration: v.duration,
        views: v.viewCount || 0,
        createdAt: v.publishedAt || null,
        contentType: 'vod',
      }));

    res.json({
      ok: true,
      handle,
      channelTitle: channel.title || channel.snippet?.title || null,
      count: vods.length,
      vods,
    });
  } catch (err) {
    console.error('[content-library] vods failed:', err.message);
    res.status(500).json({ ok: false, error: err.message || 'vods_failed' });
  }
});

router.post('/content-library/vod/analyze', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const {
      streamer, vodUrl, vodId, title, durationSec, views, platform, targetSec, maxPeaks,
    } = req.body || {};
    if (!vodUrl && !vodId) {
      return res.status(400).json({ ok: false, error: 'vodUrl or vodId required' });
    }
    const resolvedPlatform = platform
      || (isYoutubeUrl(vodUrl) ? 'youtube' : 'twitch');
    const url = vodUrl
      || (resolvedPlatform === 'youtube'
        ? `https://www.youtube.com/watch?v=${vodId}`
        : `https://www.twitch.tv/videos/${vodId}`);
    const id = vodId
      || (resolvedPlatform === 'youtube' ? extractYoutubeVideoId(url) : null)
      || (url.match(/videos\/(\d+)/)?.[1]);

    const out = await analyzeVodHighlights({
      platform: resolvedPlatform,
      streamer: streamer || 'unknown',
      vodUrl: url,
      vodId: id,
      title,
      durationSec,
      views,
      brandId: req.brandId || null,
      targetSec: targetSec != null ? Number(targetSec) : (resolvedPlatform === 'youtube' ? 45 : 45),
      maxPeaks: maxPeaks != null ? Number(maxPeaks) : 8,
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('[content-library] analyze failed:', err.message);
    res.status(500).json({ ok: false, error: err.message || 'analyze_failed' });
  }
});

router.get('/content-library/vod/:sessionId/segments', requireAuth, async (req, res) => {
  try {
    const segments = await getVodSegments(Number(req.params.sessionId));
    res.json({ ok: true, segments });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/content-library/stage-vod-window', requireAuth, resolveBrandContext, async (req, res) => {
  try {
    const body = req.body || {};
    const out = await stageVodWindowToR2({
      ...body,
      brandId: req.brandId || null,
    }, { force: !!body.force });
    res.json(out);
  } catch (err) {
    console.error('[content-library] stage-vod-window failed:', err.message);
    res.status(500).json({ ok: false, error: err.message || 'stage_failed' });
  }
});

module.exports = router;
module.exports.COMPOSE_PRESETS = COMPOSE_PRESETS;
