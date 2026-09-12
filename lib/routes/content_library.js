'use strict';
/**
 * Customer Peaks API — YouTube Most Replayed / Twitch chat peaks → stage trim window.
 *
 * GET  /content-library/vods
 * POST /content-library/vod/analyze
 * GET  /content-library/vod/:sessionId/segments
 * POST /content-library/stage-vod-window   (server YouTube pull — needs proxy on Render)
 * POST /content-library/stage-local        (customer browser upload → R2)
 * GET  /content-library/presets
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const router = require('express').Router();
const { requireAuth } = require('../auth');
const { resolveBrandContext } = require('../auth/brand_access');
const { query: dbQuery } = require('../db/postgres');
const { analyzeVodHighlights, getVodSegments } = require('../content_library/vod_highlights');
const { stageVodWindowToR2 } = require('../content_library/stage_vod_window');
const { stageLocalFile } = require('../content_library/stage_local');
const { isYoutubeUrl, extractYoutubeVideoId } = require('../content_library/youtube_heatmap');

const STAGE_LOCAL_MAX_BYTES = Math.min(
  parseInt(process.env.PEAKS_UPLOAD_MAX_MB || '512', 10) * 1024 * 1024,
  2 * 1024 * 1024 * 1024,
);

const stageLocalUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '.mp4') || '.mp4';
      cb(null, `peaks_upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: STAGE_LOCAL_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (['.mp4', '.mov', '.m4v', '.webm', '.mkv'].includes(ext)) return cb(null, true);
    cb(new Error('Unsupported file type — use mp4/mov/webm/mkv'));
  },
});

/** Compose presets we advertise (C1–C11). Prefer clip_comp_creative catalog when present. */
function listComposePresets() {
  try {
    const { getCompCreativeCatalogList, PRESET_LABELS } = require('../clip_comp_creative');
    const list = getCompCreativeCatalogList();
    if (Array.isArray(list) && list.length) {
      return list.map((p) => {
        const key = p.id || p.preset || p.key;
        return {
          code: p.code || '',
          key,
          label: p.name || p.label || PRESET_LABELS?.[key] || key,
        };
      });
    }
  } catch (_) { /* fall through */ }
  return [
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
}

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

router.get('/content-library/presets', requireAuth, (_req, res) => {
  res.json({ ok: true, presets: listComposePresets() });
});

router.get('/content-library/vods', requireAuth, resolveBrandContext, async (req, res) => {
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
    const listed = await client.getRecentLongVideos(channel.id, limit, 180);
    const videos = listed.videos || [];
    const vods = videos.map((v) => ({
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
      scanned: listed.scanned || 0,
      shortsSkipped: listed.shortsSkipped || 0,
      minDurationSec: 180,
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

/**
 * Customer browser hop: multipart MP4 → R2 library-staging (no YouTube download on Render).
 * Form fields: file (required), title, streamer, sourceUrl, platform, startSec, endSec, force, vodUrl, vodId
 */
router.post('/content-library/stage-local', requireAuth, resolveBrandContext, (req, res) => {
  stageLocalUpload.single('file')(req, res, async (multerErr) => {
    let tmpPath = null;
    try {
      if (multerErr) {
        return res.status(400).json({ ok: false, error: multerErr.message });
      }
      if (!req.file?.path) {
        return res.status(400).json({ ok: false, error: 'file required' });
      }
      tmpPath = req.file.path;
      const body = req.body || {};
      const startSec = body.startSec != null ? Number(body.startSec) : undefined;
      const endSec = body.endSec != null ? Number(body.endSec) : undefined;
      const sourceUrl = body.sourceUrl || body.url
        || (body.vodUrl && Number.isFinite(startSec) && Number.isFinite(endSec)
          ? `${String(body.vodUrl).split('#')[0]}${String(body.vodUrl).includes('?') ? '&' : '?'}cwn_win=${Math.floor(startSec)}-${Math.floor(endSec)}`
          : undefined);

      const out = await stageLocalFile({
        localPath: tmpPath,
        title: body.title || req.file.originalname,
        streamer: body.streamer,
        sourceUrl,
        platform: body.platform || 'youtube',
        startSec,
        endSec,
        force: body.force === '1' || body.force === true || body.force === 'true',
        brandId: req.brandId || null,
        thumbnailUrl: body.thumbnailUrl || null,
      }, { log: console.log });

      res.json(out);
    } catch (err) {
      console.error('[content-library] stage-local failed:', err.message);
      res.status(500).json({ ok: false, error: err.message || 'stage_local_failed' });
    } finally {
      if (tmpPath) {
        try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
      }
    }
  });
});

module.exports = router;
module.exports.COMPOSE_PRESETS = listComposePresets();
module.exports.listComposePresets = listComposePresets;
