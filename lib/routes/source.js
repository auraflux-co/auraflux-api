'use strict';
/**
 * lib/routes/source.js — Creator Source Library (CPD-274)
 *
 * Routes:
 *   GET /source/twitch/:username/content   — Twitch clips + VODs
 *   GET /source/kick/:username/content     — Kick clips + VODs
 *   GET /source/youtube/:handle/content    — YouTube videos + Shorts
 *   GET /source/youtube/:handle/resolve    — Resolve YouTube handle → channelId
 *
 * All routes return the same normalized shape:
 *   { ok: true, platform, channel, items: [ { id, title, thumbnailUrl, duration,
 *                                              publishedAt, url, viewCount, platform } ] }
 *
 * Feature gate: source.library (min_plan: operate)
 * Auth: requireAuth (Clerk session or API key via requireApiKeyOrE2EAuth)
 */

const router  = require('express').Router();
const { requireAuth, requireRole, ROLES } = require('../auth');
const { isFeatureEnabled } = require('../services/feature_gate');
const { apiLimit } = require('../rateLimiter');
const TwitchClient = require('../clients/twitch_client');
const KickClient   = require('../clients/kick_client');
const YouTubeClient = require('../clients/youtube_client');

const DEFAULT_LIMIT = 20;

function parseLimitParam(raw) {
  const n = parseInt(raw);
  if (isNaN(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, 50);
}

// ── Shared auth + gate check ──────────────────────────────────────────────────
const auth = [requireAuth, requireRole(ROLES.customer)];

function checkFeatureGate(req, res) {
  const planTier = req.user?.planTier || 'operate';
  if (!isFeatureEnabled('source.library', planTier)) {
    res.status(403).json({ ok: false, error: 'Source library not available on your plan', label: 'FEATURE_GATE' });
    return false;
  }
  return true;
}

// ── GET /source/twitch/:username/content ──────────────────────────────────────
router.get('/source/twitch/:username/content', auth, apiLimit, async (req, res) => {
  if (!checkFeatureGate(req, res)) return;

  const { username } = req.params;
  const limit = parseLimitParam(req.query.limit);

  try {
    const client  = new TwitchClient();
    const user    = await client.getUserByLogin(username);
    if (!user) {
      return res.status(404).json({ ok: false, error: `Twitch channel '${username}' not found` });
    }
    const broadcasterId = user.id;

    // Fetch both clips and VODs in parallel
    const [clipsResult, vodsResult] = await Promise.allSettled([
      client.getClips(broadcasterId, Math.ceil(limit / 2)),
      client.getVideos(broadcasterId, Math.floor(limit / 2)),
    ]);

    const clips = clipsResult.status === 'fulfilled' ? (clipsResult.value?.data || clipsResult.value || []) : [];
    const vods  = vodsResult.status  === 'fulfilled' ? (vodsResult.value?.data  || vodsResult.value  || []) : [];

    const normalizedClips = clips.slice(0, Math.ceil(limit / 2)).map((c) => ({
      id:           c.id,
      title:        c.title || 'Untitled clip',
      thumbnailUrl: c.thumbnail_url || null,
      duration:     Math.round(c.duration || 0),
      publishedAt:  c.created_at || null,
      url:          c.url || `https://www.twitch.tv/clip/${c.id}`,
      viewCount:    c.view_count || 0,
      platform:     'twitch',
      contentType:  'clip',
    }));

    const normalizedVods = vods.slice(0, Math.floor(limit / 2)).map((v) => ({
      id:           v.id,
      title:        v.title || 'Untitled VOD',
      thumbnailUrl: v.thumbnail_url ? v.thumbnail_url.replace(/%{width}/, '320').replace(/%{height}/, '180') : null,
      duration:     parseVodDuration(v.duration || '0s'),
      publishedAt:  v.created_at || null,
      url:          v.url || `https://www.twitch.tv/videos/${v.id}`,
      viewCount:    v.view_count || 0,
      platform:     'twitch',
      contentType:  'vod',
    }));

    const items = [...normalizedClips, ...normalizedVods]
      .sort((a, b) => (b.publishedAt || '') > (a.publishedAt || '') ? 1 : -1)
      .slice(0, limit);

    return res.json({
      ok: true,
      platform: 'twitch',
      channel: { id: user.id, username: user.login, displayName: user.display_name, avatarUrl: user.profile_image_url || null },
      items,
    });
  } catch (err) {
    console.error('[source/twitch] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /source/kick/:username/content ────────────────────────────────────────
router.get('/source/kick/:username/content', auth, apiLimit, async (req, res) => {
  if (!checkFeatureGate(req, res)) return;

  const { username } = req.params;
  const limit = parseLimitParam(req.query.limit);

  try {
    const client  = new KickClient();
    const channel = await client.getChannel(username);
    if (!channel) {
      return res.status(404).json({ ok: false, error: `Kick channel '${username}' not found` });
    }

    const items = await client.getContent(username, limit);
    return res.json({ ok: true, platform: 'kick', channel, items });
  } catch (err) {
    console.error('[source/kick] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /source/youtube/:handle/resolve ───────────────────────────────────────
// Resolve a YouTube handle (@handle or channel URL) to channelId.
router.get('/source/youtube/:handle/resolve', auth, apiLimit, async (req, res) => {
  if (!checkFeatureGate(req, res)) return;

  const { handle } = req.params;
  try {
    const client  = new YouTubeClient();
    const channel = await client.getChannelByHandle(handle);
    if (!channel) {
      return res.status(404).json({ ok: false, error: `YouTube channel '${handle}' not found` });
    }
    return res.json({ ok: true, channel });
  } catch (err) {
    console.error('[source/youtube/resolve] error:', err.message);
    const status = err.message.includes('YOUTUBE_API_KEY') ? 503 : 500;
    return res.status(status).json({ ok: false, error: err.message });
  }
});

// ── GET /source/youtube/:handle/content ───────────────────────────────────────
router.get('/source/youtube/:handle/content', auth, apiLimit, async (req, res) => {
  if (!checkFeatureGate(req, res)) return;

  const { handle } = req.params;
  const limit = parseLimitParam(req.query.limit);

  try {
    const client  = new YouTubeClient();
    const channel = await client.getChannelByHandle(handle);
    if (!channel) {
      return res.status(404).json({ ok: false, error: `YouTube channel '${handle}' not found` });
    }

    const items = await client.getContent(channel.id, limit);
    return res.json({ ok: true, platform: 'youtube', channel, items });
  } catch (err) {
    console.error('[source/youtube] error:', err.message);
    const status = err.message.includes('YOUTUBE_API_KEY') ? 503 : 500;
    return res.status(status).json({ ok: false, error: err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse Twitch VOD duration string "2h3m45s" → seconds.
 */
function parseVodDuration(str) {
  if (!str) return 0;
  const m = String(str).match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

module.exports = router;
