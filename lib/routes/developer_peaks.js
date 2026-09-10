'use strict';
/**
 * /v1 Peaks wrappers — platform-signal peaks for API-key clients.
 * Reuses content_library / kick_ccv / twitch_ccv services (no forked heatmap logic).
 *
 * Mounted under /v1 via developer_api.js (auth already applied).
 *
 *   GET  /v1/peaks/vods
 *   POST /v1/peaks/analyze
 *   GET  /v1/peaks/sessions/:id/segments
 *   POST /v1/peaks/stage
 *   GET  /v1/peaks/kick
 *   GET  /v1/peaks/twitch-ccv
 */

const router = require('express').Router();
const { resolveBrandContext } = require('../auth/brand_access');
const { query: dbQuery } = require('../db/postgres');
const { analyzeVodHighlights, getVodSegments } = require('../content_library/vod_highlights');
const { stageVodWindowToR2 } = require('../content_library/stage_vod_window');
const { isYoutubeUrl, extractYoutubeVideoId } = require('../content_library/youtube_heatmap');
const kickCcv = require('../kick_ccv');
const twitchCcv = require('../twitch_ccv');

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

async function resolveBrandTwitchLogin(brandId) {
  if (!brandId) return null;
  const result = await dbQuery(
    `SELECT source_channels->>'twitchLogin' AS login
       FROM client_plans
      WHERE brand_id = $1 AND active = TRUE
      LIMIT 1`,
    [brandId],
  );
  return result.rows[0]?.login || null;
}

router.get('/peaks/vods', resolveBrandContext, async (req, res) => {
  try {
    const platform = String(req.query.platform || 'youtube').toLowerCase() === 'twitch'
      ? 'twitch'
      : 'youtube';
    let handle = String(req.query.handle || req.query.streamer || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);

    if (platform === 'twitch') {
      const TwitchClient = require('../clients/twitch_client');
      const client = new TwitchClient();
      if (!handle) handle = (await resolveBrandTwitchLogin(req.brandId)) || '';
      if (!handle) {
        return res.status(400).json({
          ok: false,
          error: 'twitch_login_required',
          hint: 'Connect Twitch under My Channels, or pass ?handle=login&platform=twitch',
        });
      }
      const login = handle.replace(/^@/, '').toLowerCase();
      let user;
      try {
        user = await client.getUserByLogin(login);
      } catch (err) {
        if (/not found/i.test(err.message)) {
          return res.status(404).json({ ok: false, error: 'channel_not_found', handle: login, platform });
        }
        throw err;
      }
      const videos = await client.getVideos(user.id, limit, { type: 'archive' });
      const vods = (videos || [])
        .map((v) => ({
          platform: 'twitch',
          streamer: (user.login || login).toLowerCase(),
          vodId: String(v.id),
          title: v.title || 'Untitled VOD',
          url: v.url || `https://www.twitch.tv/videos/${v.id}`,
          thumbnailUrl: v.thumbnail_url
            ? String(v.thumbnail_url).replace('%{width}', '320').replace('%{height}', '180')
            : null,
          duration: TwitchClient.parseVodDuration(v.duration || '0s'),
          views: v.view_count || 0,
          createdAt: v.created_at || null,
          contentType: 'vod',
        }))
        .filter((v) => (v.duration || 0) >= 180);

      return res.json({
        ok: true,
        platform: 'twitch',
        handle: user.login || login,
        channelTitle: user.display_name || user.login || login,
        count: vods.length,
        vods,
      });
    }

    const YouTubeClient = require('../clients/youtube_client');
    const client = new YouTubeClient();
    if (!handle) handle = (await resolveBrandYoutubeHandle(req.brandId)) || '';
    if (!handle) {
      return res.status(400).json({
        ok: false,
        error: 'youtube_handle_required',
        hint: 'Connect a YouTube handle under My Channels, or pass ?handle=@channel',
      });
    }

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
      platform: 'youtube',
      handle,
      channelTitle: channel.title || channel.snippet?.title || null,
      count: vods.length,
      vods,
    });
  } catch (err) {
    console.error('[v1/peaks] vods failed:', err.message);
    res.status(500).json({ ok: false, error: err.message || 'vods_failed' });
  }
});

router.post('/peaks/analyze', resolveBrandContext, async (req, res) => {
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
      targetSec: targetSec != null ? Number(targetSec) : 45,
      maxPeaks: maxPeaks != null ? Number(maxPeaks) : 8,
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    console.error('[v1/peaks] analyze failed:', err.message);
    res.status(500).json({ ok: false, error: err.message || 'analyze_failed' });
  }
});

router.get('/peaks/sessions/:id/segments', async (req, res) => {
  try {
    const segments = await getVodSegments(Number(req.params.id));
    res.json({ ok: true, segments });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/peaks/stage', resolveBrandContext, async (req, res) => {
  try {
    const body = req.body || {};
    const out = await stageVodWindowToR2({
      ...body,
      brandId: req.brandId || null,
    }, { force: !!body.force });
    res.json(out);
  } catch (err) {
    console.error('[v1/peaks] stage failed:', err.message);
    res.status(500).json({ ok: false, error: err.message || 'stage_failed' });
  }
});

router.get('/peaks/kick', resolveBrandContext, async (req, res) => {
  try {
    const brandId = req.brandId || null;
    let slug = null;
    if (brandId) {
      const ch = await dbQuery(
        `SELECT source_channels->>'kickUsername' AS kick_slug
           FROM client_plans
          WHERE brand_id = $1 AND active = TRUE
          LIMIT 1`,
        [brandId],
      );
      slug = (ch.rows[0]?.kick_slug || '').trim().toLowerCase().replace(/^@/, '') || null;
    }
    const peaks = await kickCcv.listPeaksForBrand({
      brandId,
      kickSlug: slug,
      limit: Number(req.query.limit) || 10,
    });
    res.json({
      ok: true,
      brandId,
      kickSlug: slug,
      peaks,
    });
  } catch (err) {
    console.error('[v1/peaks] kick failed:', err.message);
    res.status(500).json({ ok: false, error: err.message || 'kick_peaks_failed' });
  }
});

router.get('/peaks/presets', (_req, res) => {
  try {
    const { listComposePresets } = require('./content_library');
    const { getCompCreativeCatalogList } = require('../clip_comp_creative');
    const base = listComposePresets();
    let catalog = [];
    try { catalog = getCompCreativeCatalogList() || []; } catch (_) { /* optional */ }
    const byKey = Object.fromEntries(
      (catalog || []).map((p) => [p.id || p.preset || p.key, p]),
    );
    const presets = base.map((p) => {
      const c = byKey[p.key] || {};
      return {
        code: p.code,
        key: p.key,
        label: p.label,
        tagline: c.tagline || null,
        layout: c.layout || null,
        audio: c.audio || null,
        outcome: c.outcome || null,
        buttons: c.buttons || null,
      };
    });
    res.json({
      ok: true,
      presets,
      defaultKey: 'fableflow_speed',
      note: 'Part 2 of AuraFlux: after Peaks stage, pick a C1–C11 preset and POST /v1/jobs with productionPath short_compile_clips.',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'presets_failed' });
  }
});

router.get('/peaks/twitch-ccv', resolveBrandContext, async (req, res) => {
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
    const peaks = await twitchCcv.listPeaksForBrand({
      brandId,
      twitchLogin: login,
      limit: Number(req.query.limit) || 10,
    });
    res.json({
      ok: true,
      brandId,
      twitchLogin: login,
      peaks,
    });
  } catch (err) {
    console.error('[v1/peaks] twitch-ccv failed:', err.message);
    res.status(500).json({ ok: false, error: err.message || 'twitch_ccv_failed' });
  }
});

module.exports = router;
