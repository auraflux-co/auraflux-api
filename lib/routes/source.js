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
const { requireApiKeyOrE2EAuth }         = require('../auth/api_key');
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

/** Parse filter params shared across all platform routes. */
function parseFilters(query) {
  // after: ISO date string or shorthand (24h, 7d, 30d)
  let after = null;
  const rangeParam = query.after || query.range;
  if (rangeParam) {
    if (rangeParam === '24h') {
      after = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    } else if (rangeParam === '7d') {
      after = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    } else if (rangeParam === '30d') {
      after = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    } else if (rangeParam !== 'all') {
      after = rangeParam; // raw ISO date string
    }
    // 'all' → leave after = null (no date filter)
  }
  const minDuration = query.minDuration ? parseInt(query.minDuration) : null; // seconds
  const maxDuration = query.maxDuration ? parseInt(query.maxDuration) : null;
  // type: 'vod' | 'clip' | 'short' | 'all'
  const type = query.type || 'all';
  // q: keyword filter (applied server-side on title)
  const q = query.q ? String(query.q).toLowerCase() : null;
  return { after, minDuration, maxDuration, type, q };
}

/** Apply client-side filters (duration, keyword, type) to a normalized item array. */
function applyFilters(items, { after, minDuration, maxDuration, type, q }) {
  return items.filter((item) => {
    if (after && item.publishedAt && item.publishedAt < after) return false;
    if (minDuration !== null && item.duration < minDuration) return false;
    if (maxDuration !== null && item.duration > maxDuration) return false;
    if (type !== 'all') {
      const ct = item.contentType || item.type || '';
      if (type === 'vod'   && ct !== 'vod'   && ct !== 'video') return false;
      if (type === 'clip'  && ct !== 'clip')  return false;
      if (type === 'short' && ct !== 'short') return false;
      if (type === 'video' && ct !== 'video') return false;
    }
    if (q && !item.title.toLowerCase().includes(q)) return false;
    return true;
  });
}

// ── Shared auth + gate check ──────────────────────────────────────────────────
// Accepts Clerk session (dashboard users) OR API key / E2E token (Operate E2E / developer API).
// Route the request: if the Authorization header contains a Bearer token that
// looks like an API key or E2E token, use requireApiKeyOrE2EAuth; otherwise
// fall through to Clerk session auth (requireAuth).
function flexAuth(req, res, next) {
  const raw = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  if (raw && (raw.startsWith('af_live_') || raw.startsWith('clerk_user_'))) {
    return requireApiKeyOrE2EAuth(req, res, next);
  }
  return requireAuth(req, res, next);
}
// minLevel: any role at or above customer (operator, admin) also passes
const auth = [flexAuth, requireRole({ minLevel: ROLES.CUSTOMER })];

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
  const limit   = parseLimitParam(req.query.limit);
  const filters = parseFilters(req.query);

  try {
    const client  = new TwitchClient();
    const user    = await client.getUserByLogin(username);
    if (!user) {
      return res.status(404).json({ ok: false, error: `Twitch channel '${username}' not found` });
    }
    const broadcasterId = user.id;

    const fetchMore = Math.min(50, limit * 2); // fetch more to allow for filter loss
    const twitchType = (() => {
      if (filters.type === 'clip' || filters.type === 'short') return 'clip';
      if (filters.type === 'vod'   || filters.type === 'video') return 'vod';
      return 'all';
    })();
    // Pass the date-range filter as started_at to Helix so recent clips aren't
    // buried behind high-view-count older clips (Helix sorts by view_count desc).
    // Without this, a "last 24h" filter on a channel with many older clips returns
    // nothing because the recent clips rank below the fetch limit.
    const clipsStartedAt = filters.after || null;
    const [clipsResult, vodsResult] = await Promise.allSettled([
      twitchType === 'vod'  ? Promise.resolve([]) : client.getClips(broadcasterId, fetchMore, clipsStartedAt),
      twitchType === 'clip' ? Promise.resolve([]) : client.getVideos(broadcasterId, fetchMore),
    ]);

    const clips = clipsResult.status === 'fulfilled' ? (clipsResult.value?.data || clipsResult.value || []) : [];
    const vods  = vodsResult.status  === 'fulfilled' ? (vodsResult.value?.data  || vodsResult.value  || []) : [];

    // CPD-339 (revised): Use signed GQL CDN URLs as the primary clip URL.
    // resolveClipMp4 calls Twitch's GQL API to obtain a playback-token-signed
    // clips-media-assets2.twitch.tv URL. These signed URLs:
    //   - ARE accessible from Render's datacenter IPs (signed with sig/token params)
    //   - ARE in TRUSTED_DOMAINS (downloader.js) so portal1b video review works
    //   - Can be probed with ffprobe directly (no yt-dlp needed in portal0)
    //   - Can be downloaded directly (no yt-dlp needed in assembly_service)
    // Clips where resolveClipMp4 fails (deleted/unavailable) are excluded — they
    // would fail at portal0 anyway and we avoid submitting unprocessable jobs.
    const clipUrlResults = await Promise.allSettled(
      clips.map(async (c) => {
        try {
          const { mp4Url } = await client.resolveClipMp4(c.id, 'low');
          return mp4Url || null;
        } catch (_e) {
          return null;
        }
      })
    );

    const normalizedClips = clips
      .map((c, i) => {
        const signedCdnUrl = clipUrlResults[i]?.status === 'fulfilled' ? clipUrlResults[i].value : null;
        if (!signedCdnUrl) return null; // clip unresolvable — exclude it
        return {
          id:           c.id,
          title:        c.title || 'Untitled clip',
          thumbnailUrl: c.thumbnail_url || null,
          duration:     Math.round(c.duration || 0),
          publishedAt:  c.created_at || null,
          url:          signedCdnUrl,
          pageUrl:      c.url || `https://clips.twitch.tv/${c.id}`,
          viewCount:    c.view_count || 0,
          platform:     'twitch',
          contentType:  'clip',
        };
      })
      .filter(Boolean);

    const normalizedVods = vods.map((v) => ({
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

    const items = applyFilters(
      [...normalizedClips, ...normalizedVods]
        .sort((a, b) => (b.publishedAt || '') > (a.publishedAt || '') ? 1 : -1),
      { ...filters, type: twitchType },
    ).slice(0, limit);

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

// ── GET /source/twitch/:username/resolve ──────────────────────────────────────
// Lightweight channel lookup — returns channel info only, no content fetch.
router.get('/source/twitch/:username/resolve', auth, apiLimit, async (req, res) => {
  if (!checkFeatureGate(req, res)) return;
  const { username } = req.params;
  try {
    const client = new TwitchClient();
    const user   = await client.getUserByLogin(username);
    if (!user) return res.status(404).json({ ok: false, error: `Twitch channel '${username}' not found` });
    return res.json({
      ok: true,
      channel: {
        id:          user.id,
        username:    user.login,
        displayName: user.display_name,
        avatarUrl:   user.profile_image_url || null,
      },
    });
  } catch (err) {
    console.error('[source/twitch/resolve] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /source/kick/:username/resolve ────────────────────────────────────────
// Lightweight channel lookup — returns channel info only, no content fetch.
router.get('/source/kick/:username/resolve', auth, apiLimit, async (req, res) => {
  if (!checkFeatureGate(req, res)) return;
  const { username } = req.params;
  try {
    const client  = new KickClient();
    const channel = await client.getChannel(username);
    if (!channel) return res.status(404).json({ ok: false, error: `Kick channel '${username}' not found` });
    return res.json({ ok: true, channel });
  } catch (err) {
    if (err.isKickUnavailable) {
      return res.status(503).json({ ok: false, error: err.message, code: 'KICK_CLOUDFLARE_BLOCKED' });
    }
    console.error('[source/kick/resolve] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /source/kick/:username/content ────────────────────────────────────────
router.get('/source/kick/:username/content', auth, apiLimit, async (req, res) => {
  if (!checkFeatureGate(req, res)) return;

  const { username } = req.params;
  const limit   = parseLimitParam(req.query.limit);
  const filters = parseFilters(req.query);

  try {
    const client  = new KickClient();

    // Normalise type for Kick — YouTube-only values (short/video) map to clip/vod
    const kickType = (() => {
      if (filters.type === 'clip' || filters.type === 'short') return 'clip';
      if (filters.type === 'vod'   || filters.type === 'video') return 'vod';
      return 'all';
    })();

    // When Apify is configured, fetch content first and derive the channel stub
    // from the results — avoids a separate Kick API call that Cloudflare blocks.
    // Fall back to direct getChannel only when Apify token is absent.
    let channel;
    let raw;
    if (process.env.APIFY_API_TOKEN) {
      raw = await client.getContent(username, Math.min(50, limit * 2), { type: kickType });
      // Build channel stub from first result; if no results the channel may not exist
      if (!raw || raw.length === 0) {
        return res.status(404).json({ ok: false, error: `Kick channel '${username}' not found or has no content` });
      }
      channel = {
        id:          username.toLowerCase(),
        slug:        username.toLowerCase(),
        username:    username.toLowerCase(),
        displayName: username,
        avatarUrl:   null,
        isLive:      false,
        followersCount: 0,
      };
    } else {
      channel = await client.getChannel(username);
      if (!channel) {
        return res.status(404).json({ ok: false, error: `Kick channel '${username}' not found` });
      }
      raw = await client.getContent(username, Math.min(50, limit * 2), { type: kickType });
    }

    const items = applyFilters(raw, { ...filters, type: kickType }).slice(0, limit);
    return res.json({ ok: true, platform: 'kick', channel, items });
  } catch (err) {
    if (err.isKickUnavailable) {
      console.warn('[source/kick] Cloudflare block:', err.message);
      return res.status(503).json({
        ok: false,
        error: err.message,
        code: 'KICK_CLOUDFLARE_BLOCKED',
        workaround: 'Paste a direct Kick clip URL when submitting a job.',
      });
    }
    console.error('[source/kick] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /source/youtube/:handle/playlists ────────────────────────────────────
router.get('/source/youtube/:handle/playlists', auth, apiLimit, async (req, res) => {
  if (!checkFeatureGate(req, res)) return;
  const { handle } = req.params;
  try {
    const client  = new YouTubeClient();
    const channel = await client.getChannelByHandle(handle);
    if (!channel) return res.status(404).json({ ok: false, error: `YouTube channel '${handle}' not found` });
    const playlists = await client.getPlaylists(channel.id, 20);
    return res.json({ ok: true, channel, playlists });
  } catch (err) {
    console.error('[source/youtube/playlists] error:', err.message);
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
  const limit      = parseLimitParam(req.query.limit);
  const filters    = parseFilters(req.query);
  const playlistId = req.query.playlistId || null;

  try {
    const client  = new YouTubeClient();
    const channel = await client.getChannelByHandle(handle);
    if (!channel) {
      return res.status(404).json({ ok: false, error: `YouTube channel '${handle}' not found` });
    }

    const fetchLimit = Math.min(50, limit * 2);
    const ytType = (() => {
      if (filters.type === 'short' || filters.type === 'clip') return 'short';
      if (filters.type === 'video' || filters.type === 'vod') return 'video';
      return filters.type || 'all';
    })();
    let raw;
    if (playlistId) {
      raw = await client.getPlaylistVideos(playlistId, fetchLimit, { publishedAfter: filters.after });
    } else {
      raw = await client.getContent(channel.id, fetchLimit, {
        publishedAfter: filters.after,
        type: ytType,
      });
    }
    const items = applyFilters(raw, { ...filters, type: ytType }).slice(0, limit);
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
