'use strict';
/**
 * lib/services/youtube_direct.js — Direct YouTube Data API publish (CPD-923)
 *
 * C0 adaptation of production's lib/publish/adapters/youtube.js (CPD-33).
 * Differences from production:
 *   - Tokens stored in data/youtube_tokens.json (C0 is single-channel localhost;
 *     production uses a Postgres token_store).
 *   - No per-customer quota tracking (single channel, ~6 uploads/day max).
 *
 * OAuth scopes: youtube.upload + youtube.readonly
 * Quota cost: ~1,600 units per upload + 50 per thumbnail set (10,000/day default)
 *
 * Activation is gated by YOUTUBE_DIRECT_PUBLISH=true — until thumbnail parity
 * is verified, Upload-Post remains the default YouTube path (per CPD-923).
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { resolveSyntheticMediaFlags } = require('../publish_synthetic');
const {
  getProfileConfig,
  hasBackupProfile,
  isQuotaExceededError,
  getApiProfileStatus,
} = require('./youtube_api_profiles');

const YT_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const YT_UPLOAD_BASE = 'https://www.googleapis.com/upload/youtube/v3';

const TOKEN_FILE = path.join(__dirname, '..', '..', 'data', 'youtube_tokens.json');

// ── Token store (file-backed) ────────────────────────────────────────────────

function loadTokens() {
  const envRefresh = process.env.YOUTUBE_REFRESH_TOKEN || process.env.DRIVE_REFRESH_TOKEN;
  if (envRefresh) {
    return { refresh_token: envRefresh };
  }
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function isConnected() {
  const t = loadTokens();
  return !!(t && t.refresh_token);
}

// ── OAuth ────────────────────────────────────────────────────────────────────

function buildAuthUrl(redirectUri, state) {
  return buildAuthUrlForProfile('primary', redirectUri, state);
}

function buildAuthUrlForProfile(profile, redirectUri, state) {
  const cfg = getProfileConfig(profile);
  const params = new URLSearchParams({
    client_id: cfg.clientId || '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/yt-analytics.readonly',
    access_type: 'offline',
    prompt: 'select_account consent',
    state: state || '',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode(code, redirectUri) {
  return exchangeCodeForProfile('primary', code, redirectUri);
}

async function exchangeCodeForProfile(profile, code, redirectUri) {
  const cfg = getProfileConfig(profile);
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error(`${profile} YouTube OAuth client_id/secret missing`);
  }
  const res = await axios.post('https://oauth2.googleapis.com/token', {
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  return res.data;
}

const _backupAccessCache = { access_token: null, expires_at: 0 };

async function refreshAccessTokenForProfile(profile) {
  const cfg = getProfileConfig(profile);
  if (!cfg.refreshToken || !cfg.clientId || !cfg.clientSecret) {
    throw new Error(profile === 'backup'
      ? 'YouTube backup API not configured (set YOUTUBE_BACKUP_CLIENT_ID, YOUTUBE_BACKUP_CLIENT_SECRET, YOUTUBE_BACKUP_REFRESH_TOKEN)'
      : 'YouTube OAuth client credentials missing');
  }
  const res = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    grant_type: 'refresh_token',
  });
  return res.data;
}

/** Get a valid access token for primary or backup GCP project OAuth app. */
async function getAccessTokenForProfile(profile = 'primary') {
  if (profile === 'backup') {
    if (!hasBackupProfile()) throw new Error('YouTube backup API not configured');
    if (_backupAccessCache.access_token && _backupAccessCache.expires_at > Date.now() + 60_000) {
      return _backupAccessCache.access_token;
    }
    const refreshed = await refreshAccessTokenForProfile('backup');
    _backupAccessCache.access_token = refreshed.access_token;
    _backupAccessCache.expires_at = Date.now() + (refreshed.expires_in || 3600) * 1000;
    return refreshed.access_token;
  }

  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error('YouTube not connected — visit /connect/youtube to authorize the channel');
  }
  const expiresAt = tokens.expires_at ? new Date(tokens.expires_at).getTime() : 0;
  if (tokens.access_token && expiresAt > Date.now() + 60_000) {
    return tokens.access_token;
  }
  const refreshed = await refreshAccessTokenForProfile('primary');
  tokens.access_token = refreshed.access_token;
  tokens.expires_at = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString();
  saveTokens(tokens);
  return tokens.access_token;
}

/** Retry a YouTube API operation on the backup GCP project when primary quota is exceeded. */
async function withQuotaFailover(run) {
  try {
    return await run('primary');
  } catch (err) {
    if (hasBackupProfile() && isQuotaExceededError(err)) {
      console.warn('[youtube_direct] primary quota exceeded — failing over to backup GCP project');
      return await run('backup');
    }
    throw err;
  }
}

/** Get a valid access token (primary profile). */
async function getAccessToken() {
  return getAccessTokenForProfile('primary');
}

function getYoutubeApiProfileStatus() {
  return getApiProfileStatus({ primaryConnected: isConnected() });
}

async function getChannelInfo(accessToken) {
  const res = await axios.get(`${YT_API_BASE}/channels?part=snippet&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const ch = res.data?.items?.[0];
  return ch ? { channelId: ch.id, channelTitle: ch.snippet?.title } : null;
}

// ── Publish ──────────────────────────────────────────────────────────────────

// CPD-982: YouTube rejects angle brackets in title/description with an opaque 400.
function _ytText(s, max) {
  return String(s || '').replace(/[<>]/g, '').slice(0, max);
}

// CPD-982: tags must be a plain-string array; '#' prefixes are wasted chars and the
// CUMULATIVE limit is 500 chars (multi-word tags cost +2 for implicit quotes).
// Transcript-driven publish copy feeds hashtags here, which blew the limit on comps.
const DEFAULT_BLOCKED_TAGS = [
  'businessrocket',
  'businessrocket.ai',
  'robert@businessrocket.ai',
  'robert@auraflux.co',
];

function blockedTagPatterns() {
  const fromEnv = (process.env.YOUTUBE_BLOCKED_TAGS || '')
    .split(/[,;\n]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...DEFAULT_BLOCKED_TAGS, ...fromEnv].map((s) => s.toLowerCase()))];
}

function isBlockedTag(raw) {
  const t = String(raw || '').trim().toLowerCase();
  if (!t) return true;
  if (t.includes('@')) return true;
  const blocked = blockedTagPatterns();
  return blocked.some((b) => t === b || t.includes(b));
}

function _ytTags(tags) {
  const arr = Array.isArray(tags) ? tags
    : (typeof tags === 'string' ? tags.split(/[,\s]+/) : []);
  const out = [];
  let total = 0;
  for (let t of arr) {
    t = String(t || '').replace(/^#+/, '').replace(/[<>]/g, '').trim();
    if (!t || isBlockedTag(t) || out.includes(t)) continue;
    if (t.length > 100) t = t.slice(0, 100);
    const cost = t.length + (t.includes(' ') ? 2 : 0) + 1;
    if (total + cost > 495) break; // stay clear of the 500 hard limit
    out.push(t);
    total += cost;
    if (out.length >= 50) break;
  }
  return out;
}

// CPD-982: axios errors hide the API response body — rethrow with it embedded so
// gate5's logError captures WHY YouTube said 400, not just the status code.
function _ytApiError(e, stage) {
  const status = e.response?.status;
  let body = '';
  try { body = JSON.stringify(e.response?.data || '').slice(0, 800); } catch (_) { /* ignore */ }
  const err = new Error(`YouTube ${stage} failed${status ? ` (${status})` : ''}: ${e.message}${body && body !== '""' ? ` — ${body}` : ''}`);
  err.status = status;
  err.responseBody = e.response?.data;
  return err;
}

/**
 * Upload a video to YouTube via resumable upload, then set the custom thumbnail.
 *
 * @param {object} p
 * @param {string} p.videoSource    — local file path OR public URL (R2)
 * @param {object} p.metadata       — { title, description, tags, categoryId, privacyStatus, publishAt, contentType, heygenUsed, containsSyntheticMedia }
 * @param {string} [p.thumbnailUrl] — public URL or local path of custom thumbnail
 * @param {string} [p.jobId]        — log tag
 * @returns {object} { videoId, url, status, thumbnailSet }
 */
function resolveContainsSyntheticMedia(metadata = {}) {
  if (typeof metadata.containsSyntheticMedia === 'boolean') {
    return metadata.containsSyntheticMedia;
  }
  return resolveSyntheticMediaFlags({
    jobType: metadata.jobType || metadata.contentType,
    contentType: metadata.contentType,
    isAigc: metadata.isAigc,
    heygenUsed: metadata.heygenUsed,
  }).containsSyntheticMedia;
}

/** Post-upload correction when a video was mis-tagged as synthetic/AI. */
async function setContainsSyntheticMedia(videoId, containsSyntheticMedia = false) {
  if (!videoId) throw new Error('setContainsSyntheticMedia: videoId required');
  return withQuotaFailover(async (profile) => {
    const accessToken = await getAccessTokenForProfile(profile);
    await axios.put(
      `${YT_API_BASE}/videos?part=status`,
      { id: videoId, status: { containsSyntheticMedia: !!containsSyntheticMedia } },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
    );
    return { videoId, containsSyntheticMedia: !!containsSyntheticMedia };
  });
}

async function publish({ videoSource, metadata, thumbnailUrl, jobId = '' }) {
  return withQuotaFailover(async (profile) => {
  const accessToken = await getAccessTokenForProfile(profile);
  const containsSyntheticMedia = resolveContainsSyntheticMedia(metadata);

  const videoMeta = {
    snippet: {
      title: _ytText(metadata.title, 100) || 'New video',
      description: _ytText(metadata.description, 5000),
      tags: _ytTags(metadata.tags),
      categoryId: metadata.categoryId || '24',
      defaultLanguage: 'en',
      defaultAudioLanguage: 'en',
    },
    status: {
      privacyStatus: metadata.privacyStatus || 'private',
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia,
      ...(metadata.publishAt ? { publishAt: metadata.publishAt, privacyStatus: 'private' } : {}),
    },
  };

  console.log(`[youtube_direct] ${jobId}: containsSyntheticMedia=${containsSyntheticMedia}`);

  // Resumable upload initiation
  let initRes;
  try {
    initRes = await axios.post(
      `${YT_UPLOAD_URL}?uploadType=resumable&part=snippet,status`,
      videoMeta,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'X-Upload-Content-Type': 'video/*',
        },
      }
    );
  } catch (e) {
    throw _ytApiError(e, 'upload init');
  }
  const uploadUrl = initRes.headers.location;
  if (!uploadUrl) throw new Error('YouTube: no resumable upload URL returned');

  // Stream the video (local file or R2 URL)
  let videoStream, videoSize;
  if (/^https?:\/\//.test(videoSource)) {
    const dlRes = await axios.get(videoSource, { responseType: 'stream' });
    videoStream = dlRes.data;
    videoSize = parseInt(dlRes.headers['content-length'] || '0', 10);
  } else {
    videoStream = fs.createReadStream(videoSource);
    videoSize = fs.statSync(videoSource).size;
  }

  console.log(`[youtube_direct] ${jobId}: uploading ${(videoSize / 1024 / 1024).toFixed(1)}MB...`);
  let uploadRes;
  try {
    uploadRes = await axios.put(uploadUrl, videoStream, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'video/*',
        ...(videoSize ? { 'Content-Length': videoSize } : {}),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
  } catch (e) {
    throw _ytApiError(e, 'video upload');
  }

  const videoId = uploadRes.data?.id;
  if (!videoId) throw new Error('YouTube: upload succeeded but no videoId returned');

  // Custom thumbnail — REQUIRED parity with the Upload-Post flow (CPD-923).
  // Thumbnail failure is reported (not swallowed) so parity gaps are visible.
  let thumbnailSet = false;
  if (thumbnailUrl) {
    try {
      // Buffer the image (max 2MB anyway) — the thumbnails/set endpoint rejects
      // chunked streams with "The request does not include the image content."
      let thumbBuf;
      if (/^https?:\/\//.test(thumbnailUrl)) {
        const tRes = await axios.get(thumbnailUrl, { responseType: 'arraybuffer' });
        thumbBuf = Buffer.from(tRes.data);
      } else {
        thumbBuf = fs.readFileSync(thumbnailUrl);
      }
      const mime = thumbnailUrl.toLowerCase().includes('.png') ? 'image/png' : 'image/jpeg';
      await axios.post(`${YT_UPLOAD_BASE}/thumbnails/set?uploadType=media&videoId=${videoId}`, thumbBuf, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': mime,
          'Content-Length': thumbBuf.length,
        },
        maxBodyLength: Infinity,
      });
      thumbnailSet = true;
      console.log(`[youtube_direct] ${jobId}: custom thumbnail set`);
    } catch (e) {
      console.warn(`[youtube_direct] ${jobId}: thumbnail set FAILED — ${e.response?.data?.error?.message || e.message}`);
    }
  }

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`[youtube_direct] ${jobId}: ✅ uploaded ${url}`);
  return {
    videoId,
    url,
    status: videoMeta.status.privacyStatus,
    thumbnailSet,
  };
  });
}

// ---------------------------------------------------------------------------
// YouTube Live (CPD-945 — Live Grid)
// ---------------------------------------------------------------------------

const YT_API = 'https://www.googleapis.com/youtube/v3';

/**
 * Create a reusable RTMP ingest stream.
 * @returns {{ streamId, rtmpUrl }} rtmpUrl is ready for ffmpeg -f flv output
 */
async function createLiveStream({ title = 'ClipzWorld Live Grid ingest', resolution = '1080p', frameRate = '60fps' } = {}) {
  return withQuotaFailover(async (profile) => {
  const accessToken = await getAccessTokenForProfile(profile);
  const res = await axios.post(`${YT_API}/liveStreams?part=snippet,cdn,contentDetails`, {
    snippet: { title },
    cdn: { ingestionType: 'rtmp', resolution, frameRate },
    contentDetails: { isReusable: true },
  }, { headers: { Authorization: `Bearer ${accessToken}` } });
  const s = res.data;
  const ing = s.cdn?.ingestionInfo || {};
  return {
    streamId: s.id,
    rtmpUrl: `${ing.ingestionAddress}/${ing.streamName}`,
  };
  });
}

/**
 * Create a broadcast, bind it to a stream, and rely on enableAutoStart to go
 * live as soon as RTMP data flows. autoStop is OFF so master-compositor
 * restarts (quadrant swaps) don't end the broadcast.
 * @returns {{ broadcastId, watchUrl }}
 */
async function createLiveBroadcast({ title, description = '', privacyStatus = 'public', streamId, scheduledStartTime }) {
  if (!title || !streamId) throw new Error('createLiveBroadcast: title and streamId required');
  return withQuotaFailover(async (profile) => {
  const accessToken = await getAccessTokenForProfile(profile);
  const startIso = scheduledStartTime || new Date().toISOString();
  const res = await axios.post(`${YT_API}/liveBroadcasts?part=snippet,status,contentDetails`, {
    snippet: { title: title.slice(0, 100), description: description.slice(0, 5000), scheduledStartTime: startIso },
    status: { privacyStatus, selfDeclaredMadeForKids: false },
    contentDetails: {
      enableAutoStart: true,
      enableAutoStop: false,
      latencyPreference: 'low',
    },
  }, { headers: { Authorization: `Bearer ${accessToken}` } });
  const broadcastId = res.data.id;

  await axios.post(`${YT_API}/liveBroadcasts/bind?id=${broadcastId}&part=id&streamId=${encodeURIComponent(streamId)}`,
    null, { headers: { Authorization: `Bearer ${accessToken}` } });

  return { broadcastId, watchUrl: `https://youtube.com/live/${broadcastId}` };
  });
}

/** Update live title and (optionally) description in one snippet update. */
async function updateBroadcastMeta(broadcastId, { title, description, scheduledStartTime } = {}) {
  return withQuotaFailover(async (profile) => {
  const accessToken = await getAccessTokenForProfile(profile);
  const snippet = { title: String(title).slice(0, 100) };
  if (description != null) snippet.description = String(description).slice(0, 5000);
  if (scheduledStartTime != null) {
    snippet.scheduledStartTime = scheduledStartTime;
  } else {
    try {
      const cur = await axios.get(`${YT_API}/liveBroadcasts?part=snippet&id=${broadcastId}`,
        { headers: { Authorization: `Bearer ${accessToken}` } });
      const prev = cur.data.items?.[0]?.snippet?.scheduledStartTime;
      snippet.scheduledStartTime = prev || new Date().toISOString();
    } catch (_) {
      snippet.scheduledStartTime = new Date().toISOString();
    }
  }
  await axios.put(`${YT_API}/liveBroadcasts?part=snippet`, {
    id: broadcastId,
    snippet,
  }, { headers: { Authorization: `Bearer ${accessToken}` } });

  // Watch page reads the video resource — mirror title/description there too.
  try {
    const vres = await axios.get(`${YT_API}/videos?part=snippet&id=${broadcastId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } });
    const item = vres.data.items?.[0];
    if (item?.snippet) {
      const vsnippet = {
        ...item.snippet,
        title: snippet.title,
      };
      if (description != null) vsnippet.description = snippet.description;
      await axios.put(`${YT_API}/videos?part=snippet`, {
        id: broadcastId,
        snippet: vsnippet,
      }, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } });
    }
  } catch (_) {
    /* liveBroadcasts update succeeded; video mirror is best-effort */
  }
  });
}

/** Update the live title (e.g. "LIVE: jasontheween, stableronaldo +2"). */
async function updateBroadcastTitle(broadcastId, title) {
  return updateBroadcastMeta(broadcastId, { title });
}

/**
 * Minimal listing update — title + description only (~3 quota units).
 * Skips channel keywords, playlist, tags, chat, thumbnail.
 */
async function updateBroadcastListingLite(broadcastId, seo = {}, log = () => {}) {
  if (!broadcastId || !seo?.title) return { ok: false, reason: 'missing broadcastId or title' };
  await updateBroadcastMeta(broadcastId, { title: seo.title, description: seo.description });
  log(`listing updated → ${seo.title.slice(0, 60)}`);
  return { ok: true, title: seo.title };
}

/**
 * Full discoverability SEO for solo streams — title, description (hashtags), tags, playlist, public.
 * Skips channel keyword sanitize, members chat, thumbnail (call sanitize once per batch instead).
 */
async function applyLiveBroadcastSeoDiscoverable(broadcastId, seo = {}, {
  log = () => {},
  playlistId,
  setPublic = true,
} = {}) {
  if (!broadcastId || !seo?.title) return { ok: false, reason: 'missing broadcastId or title' };
  const out = { ok: true, title: seo.title, tags: false, playlist: false, public: false };

  if (setPublic) {
    try {
      const st = await getBroadcastStatus(broadcastId);
      if (st?.privacyStatus && st.privacyStatus !== 'public') {
        await updateBroadcastPrivacy(broadcastId, 'public');
        log('privacy → public');
        out.public = true;
      }
    } catch (e) {
      log(`privacy update skipped: ${e.response?.data?.error?.message || e.message}`);
    }
  }

  await updateBroadcastMeta(broadcastId, { title: seo.title, description: seo.description });
  log(`title + description → ${seo.title.slice(0, 60)}`);

  if (seo.tags?.length) {
    try {
      out.tags = await updateVideoTags(broadcastId, seo.tags);
      log(`tags set (${seo.tags.length})`);
    } catch (e) {
      log(`tags update failed: ${e.response?.data?.error?.message || e.message}`);
    }
  }

  try {
    const pid = playlistId || resolveLivePlaylistIdFromConfig?.() || await resolveLivePlaylistId();
    if (pid) {
      out.playlist = await addVideoToPlaylist(broadcastId, pid);
      log(`playlist ${pid}`);
    }
  } catch (e) {
    log(`playlist skipped: ${e.response?.data?.error?.message || e.message}`);
  }

  return out;
}

/** Update tags on the live video (broadcastId === videoId while live). */
async function updateVideoTags(videoId, tags) {
  if (!videoId || !tags?.length) return false;
  return withQuotaFailover(async (profile) => {
  const accessToken = await getAccessTokenForProfile(profile);
  const res = await axios.get(`${YT_API}/videos?part=snippet&id=${videoId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } });
  const item = res.data.items?.[0];
  if (!item) return false;
  const snippet = { ...item.snippet, tags: _ytTags(tags) };
  await axios.put(`${YT_API}/videos?part=snippet`, {
    id: videoId,
    snippet,
  }, { headers: { Authorization: `Bearer ${accessToken}` } });
  return true;
  });
}

/** Set custom thumbnail on a live or VOD video. */
async function setVideoThumbnail(videoId, thumbnailPath) {
  if (!videoId || !thumbnailPath) return false;
  return withQuotaFailover(async (profile) => {
  const accessToken = await getAccessTokenForProfile(profile);
  const thumbBuf = fs.readFileSync(thumbnailPath);
  const mime = thumbnailPath.toLowerCase().includes('.png') ? 'image/png' : 'image/jpeg';
  await axios.post(`${YT_UPLOAD_BASE}/thumbnails/set?uploadType=media&videoId=${videoId}`, thumbBuf, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': mime,
      'Content-Length': thumbBuf.length,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return true;
  });
}

let _livePlaylistIdCache = null;

function resolveLivePlaylistIdFromConfig() {
  if (process.env.YOUTUBE_LIVE_PLAYLIST_ID) return process.env.YOUTUBE_LIVE_PLAYLIST_ID;
  try {
    const { loadGoLiveConfig } = require('../live_grid/go_live_template');
    const cfg = loadGoLiveConfig();
    if (cfg?.seo?.playlistId) return cfg.seo.playlistId;
  } catch (_) { /* optional at boot */ }
  return null;
}

/** Remove blocked tags/emails from channel keywords (YouTube auto-applies these to every video). */
async function sanitizeChannelKeywords(log = () => {}) {
  return withQuotaFailover(async (profile) => {
  const accessToken = await getAccessTokenForProfile(profile);
  const res = await axios.get(`${YT_API}/channels?part=brandingSettings&mine=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } });
  const ch = res.data.items?.[0];
  if (!ch?.id) return { ok: false, reason: 'no_channel' };
  const raw = ch.brandingSettings?.channel?.keywords || '';
  const parts = raw.split(/\s+/).filter(Boolean);
  const cleaned = parts.filter((p) => !isBlockedTag(p));
  if (cleaned.length === parts.length) return { ok: true, changed: false };
  const removed = parts.filter((p) => isBlockedTag(p));
  await axios.put(`${YT_API}/channels?part=brandingSettings`, {
    id: ch.id,
    brandingSettings: {
      ...ch.brandingSettings,
      channel: {
        ...ch.brandingSettings.channel,
        keywords: cleaned.join(' '),
      },
    },
  }, { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } });
  log(`removed blocked channel keywords: ${removed.join(', ')}`);
  return { ok: true, changed: true, removed };
  });
}

/** Resolve "ClipzWorld Live streams" playlist id (env override or title search). */
async function resolveLivePlaylistId(title = process.env.YOUTUBE_LIVE_PLAYLIST_TITLE || 'ClipzWorld Live streams') {
  const fromConfig = resolveLivePlaylistIdFromConfig();
  if (fromConfig) return fromConfig;
  if (_livePlaylistIdCache) return _livePlaylistIdCache;
  return withQuotaFailover(async (profile) => {
  const accessToken = await getAccessTokenForProfile(profile);
  let pageToken = null;
  do {
    const params = { part: 'snippet', mine: true, maxResults: 50 };
    if (pageToken) params.pageToken = pageToken;
    const res = await axios.get(`${YT_API}/playlists`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params,
    });
    const match = (res.data.items || []).find(p =>
      String(p.snippet?.title || '').trim().toLowerCase() === String(title).trim().toLowerCase());
    if (match) {
      _livePlaylistIdCache = match.id;
      return match.id;
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return null;
  });
}

/** Add a live/VOD video to a playlist (skips if already present). */
async function addVideoToPlaylist(videoId, playlistId) {
  if (!videoId || !playlistId) return false;
  return withQuotaFailover(async (profile) => {
  const accessToken = await getAccessTokenForProfile(profile);
  try {
    const list = await axios.get(`${YT_API}/playlistItems`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { part: 'snippet', playlistId, maxResults: 50, videoId },
    });
    if ((list.data.items || []).some(it => it.snippet?.resourceId?.videoId === videoId)) return true;
  } catch (_) { /* playlistItems videoId filter may fail on some API versions — insert anyway */ }
  await axios.post(`${YT_API}/playlistItems?part=snippet`, {
    snippet: {
      playlistId,
      resourceId: { kind: 'youtube#video', videoId },
    },
  }, { headers: { Authorization: `Bearer ${accessToken}` } });
  return true;
  });
}

/** Title, description, tags, playlist, and optional thumbnail for a live broadcast. */
async function applyLiveBroadcastSeo(broadcastId, seo = {}, { thumbnailPath, log = () => {}, playlistId, membersOnlyChat, setPublic } = {}) {
  if (!broadcastId || !seo?.title) return { ok: false };
  const out = { ok: true, tags: false, playlist: false, thumbnail: false, channelKeywords: false, chatPolicy: false, public: false };

  try {
    const kw = await sanitizeChannelKeywords(log);
    out.channelKeywords = kw.changed === true;
  } catch (e) {
    log(`channel keyword sanitize skipped: ${e.response?.data?.error?.message || e.message}`);
  }

  if (setPublic) {
    try {
      const st = await getBroadcastStatus(broadcastId);
      if (st?.privacyStatus && st.privacyStatus !== 'public') {
        await updateBroadcastPrivacy(broadcastId, 'public');
        log('privacy → public');
        out.public = true;
      }
    } catch (e) {
      log(`privacy update failed: ${e.response?.data?.error?.message || e.message}`);
    }
  }

  await updateBroadcastMeta(broadcastId, { title: seo.title, description: seo.description });
  if (seo.tags?.length) {
    try {
      out.tags = await updateVideoTags(broadcastId, seo.tags);
    } catch (e) {
      log(`YouTube tags update failed: ${e.response?.data?.error?.message || e.message}`);
    }
  }
  if (thumbnailPath) {
    try {
      out.thumbnail = await setVideoThumbnail(broadcastId, thumbnailPath);
    } catch (e) {
      log(`YouTube thumbnail set failed: ${e.response?.data?.error?.message || e.message}`);
    }
  }
  try {
    const pid = playlistId || await resolveLivePlaylistId();
    if (pid) {
      out.playlist = await addVideoToPlaylist(broadcastId, pid);
      log(`added to live playlist ${pid}`);
    } else {
      log('live playlist not found — set YOUTUBE_LIVE_PLAYLIST_ID or config/live_grid_go_live.json seo.playlistId');
    }
  } catch (e) {
    log(`playlist add failed: ${e.response?.data?.error?.message || e.message}`);
  }

  const wantMembersChat = membersOnlyChat != null
    ? !!membersOnlyChat
    : String(process.env.LIVE_GRID_CHAT_MEMBERS_ONLY ?? 'on').toLowerCase() === 'on';
  if (wantMembersChat) {
    try {
      out.chatPolicy = await applyMembersOnlyLiveChat(broadcastId, log);
    } catch (e) {
      log(`members-only chat policy skipped: ${e.response?.data?.error?.message || e.message}`);
    }
  }
  return out;
}

/**
 * Members-only live chat (any membership tenure).
 * YouTube Data API v3 does not document a public setter — use Studio InnerTube when enabled.
 */
async function applyMembersOnlyLiveChat(broadcastId, log = () => {}) {
  if (String(process.env.LIVE_GRID_CHAT_MEMBERS_ONLY_API || 'innertube').toLowerCase() === 'off') {
    log('members-only chat: set in Studio → Live chat → Participants → Members (API off)');
    return false;
  }
  return withQuotaFailover(async (profile) => {
  const accessToken = await getAccessTokenForProfile(profile);
  const res = await axios.get(`${YT_API}/liveBroadcasts?part=snippet&id=${broadcastId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } });
  const liveChatId = res.data.items?.[0]?.snippet?.liveChatId;
  if (!liveChatId) {
    log('members-only chat: no liveChatId yet (broadcast not ready)');
    return false;
  }
  // InnerTube endpoint used by YouTube Studio — best-effort; requires same OAuth token.
  try {
    await axios.post('https://studio.youtube.com/youtubei/v1/live_chat/set_sponsor_only_mode', {
      context: { client: { clientName: 'WEB_CREATOR', clientVersion: '1.20240101.00.00' } },
      liveChatId,
      enabled: true,
      // any membership tenure (not "new members only")
      sponsorOnlyMode: 'SPONSOR_ONLY_MODE_ENABLED',
    }, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Origin': 'https://studio.youtube.com',
      },
      timeout: 15_000,
    });
    log(`members-only live chat enabled (chatId ${liveChatId.slice(0, 12)}…)`);
    return true;
  } catch (e) {
    log(`members-only chat API failed — set manually in Studio (Participants → Members): ${e.response?.data?.error?.message || e.message}`);
    return false;
  }
  });
}

/** End the broadcast (VOD stays on the channel). */
async function endLiveBroadcast(broadcastId) {
  return withQuotaFailover(async (profile) => {
  const accessToken = await getAccessTokenForProfile(profile);
  await axios.post(`${YT_API}/liveBroadcasts/transition?id=${broadcastId}&broadcastStatus=complete&part=status`,
    null, { headers: { Authorization: `Bearer ${accessToken}` } });
  });
}

async function _fetchChannelBroadcasts(part, { activeOnly = true } = {}) {
  return withQuotaFailover(async (profile) => {
  const accessToken = await getAccessTokenForProfile(profile);
  const channel = await getChannelInfo(accessToken);
  const params = new URLSearchParams({ part, maxResults: '50' });
  if (channel?.channelId) {
    params.set('channelId', channel.channelId);
    if (activeOnly) params.set('broadcastStatus', 'active');
  } else {
    params.set('mine', 'true');
  }
  const res = await axios.get(`${YT_API}/liveBroadcasts?${params.toString()}`,
    { headers: { Authorization: `Bearer ${accessToken}` } });
  let items = res.data.items || [];
  if (!channel?.channelId && activeOnly) {
    items = items.filter((b) => b.status?.lifeCycleStatus !== 'complete');
  }
  return items;
  });
}

/** List this channel's broadcasts still in active (live/testing) state. */
async function listActiveBroadcasts() {
  return (await _fetchChannelBroadcasts('id,status,snippet', { activeOnly: true })).map((b) => ({
    broadcastId: b.id,
    lifeCycleStatus: b.status?.lifeCycleStatus,
    title: b.snippet?.title,
  }));
}

/** Active broadcasts with ingest stream binding — for auto-discovery without Studio IDs. */
async function listDiscoverableBroadcasts() {
  return (await _fetchChannelBroadcasts('id,status,snippet,contentDetails', { activeOnly: true })).map((b) => ({
    broadcastId: b.id,
    lifeCycleStatus: b.status?.lifeCycleStatus,
    privacyStatus: b.status?.privacyStatus || null,
    title: b.snippet?.title,
    boundStreamId: b.contentDetails?.boundStreamId || null,
    watchUrl: `https://youtube.com/live/${b.id}`,
  }));
}

/**
 * CPD-996: end orphaned live broadcasts at server boot.
 * A restart kills the ffmpeg feed with the process, but YouTube keeps the
 * broadcast "live" with no input — leaving a dead duplicate on the channel.
 * At boot no session can legitimately be running, so any active broadcast is
 * an orphan and is transitioned to complete (the VOD stays on the channel).
 * Non-fatal: API errors are logged and swallowed.
 * @returns {Promise<number>} count of broadcasts ended
 */
async function reconcileOrphanedBroadcasts() {
  if (!isConnected()) return 0;
  let ended = 0;
  try {
    const active = await listActiveBroadcasts();
    for (const b of active) {
      try {
        await endLiveBroadcast(b.broadcastId);
        ended++;
        console.log(`[yt-reconcile] ended orphaned broadcast ${b.broadcastId} ("${b.title}")`);
      } catch (e) {
        console.warn(`[yt-reconcile] failed to end ${b.broadcastId}: ${e.response?.data?.error?.message || e.message}`);
      }
    }
    if (active.length === 0) console.log('[yt-reconcile] no orphaned live broadcasts');
  } catch (e) {
    console.warn(`[yt-reconcile] reconciliation skipped: ${e.response?.data?.error?.message || e.message}`);
  }
  return ended;
}

/** Update live broadcast visibility (public / unlisted / private). */
async function updateBroadcastPrivacy(broadcastId, privacyStatus = 'public') {
  if (!broadcastId) throw new Error('broadcastId required');
  return withQuotaFailover(async (profile) => {
  const accessToken = await getAccessTokenForProfile(profile);
  await axios.put(`${YT_API}/liveBroadcasts?part=status`, {
    id: broadcastId,
    status: { privacyStatus, selfDeclaredMadeForKids: false },
  }, { headers: { Authorization: `Bearer ${accessToken}` } });
  });
}

/** lifeCycleStatus: created|ready|testing|live|complete (+ recording details). */
async function getBroadcastStatus(broadcastId) {
  return withQuotaFailover(async (profile) => {
  const accessToken = await getAccessTokenForProfile(profile);
  const res = await axios.get(`${YT_API}/liveBroadcasts?part=status,snippet&id=${broadcastId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } });
  const b = res.data.items?.[0];
  return b ? {
    lifeCycleStatus: b.status?.lifeCycleStatus,
    privacyStatus: b.status?.privacyStatus || null,
    title: b.snippet?.title,
    scheduledStartTime: b.snippet?.scheduledStartTime || null,
  } : null;
  });
}

/** Ingest stream health — detects videoIngestionStarved (Upcoming stuck on watch page). */
async function getLiveStreamHealth(streamId) {
  if (!streamId) return null;
  return withQuotaFailover(async (profile) => {
  const accessToken = await getAccessTokenForProfile(profile);
  const res = await axios.get(`${YT_API}/liveStreams?part=status&id=${encodeURIComponent(streamId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } });
  const st = res.data.items?.[0]?.status;
  if (!st) return null;
  const issues = st.healthStatus?.configurationIssues || [];
  return {
    streamStatus: st.streamStatus || null,
    healthStatus: st.healthStatus?.status || null,
    videoIngestionStarved: issues.some((i) => i.type === 'videoIngestionStarved'),
    issues,
  };
  });
}

/** Force testing→live when enableAutoStart did not fire (RTMP connected but lifecycle stuck ready). */
async function transitionBroadcastToLive(broadcastId) {
  return withQuotaFailover(async (profile) => {
  const accessToken = await getAccessTokenForProfile(profile);
  await axios.post(`${YT_API}/liveBroadcasts/transition?id=${broadcastId}&broadcastStatus=live&part=status`,
    null, { headers: { Authorization: `Bearer ${accessToken}` } });
  });
}

/** Like/view counts for a live or VOD video (CPD-1005 like milestones). */
async function getVideoStatistics(videoId) {
  return withQuotaFailover(async (profile) => {
  const accessToken = await getAccessTokenForProfile(profile);
  const res = await axios.get(`${YT_API}/videos?part=statistics&id=${videoId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } });
  const s = res.data.items?.[0]?.statistics || {};
  return {
    likeCount: parseInt(s.likeCount || '0', 10),
    viewCount: parseInt(s.viewCount || '0', 10),
  };
  });
}

module.exports = {
  publish,
  buildAuthUrl,
  buildAuthUrlForProfile,
  exchangeCode,
  exchangeCodeForProfile,
  getAccessToken,
  getAccessTokenForProfile,
  getYoutubeApiProfileStatus,
  hasBackupProfile,
  getChannelInfo,
  loadTokens,
  saveTokens,
  isConnected,
  createLiveStream,
  createLiveBroadcast,
  updateBroadcastTitle,
  updateBroadcastMeta,
  updateBroadcastListingLite,
  applyLiveBroadcastSeoDiscoverable,
  updateBroadcastPrivacy,
  updateVideoTags,
  setVideoThumbnail,
  resolveLivePlaylistId,
  resolveLivePlaylistIdFromConfig,
  sanitizeChannelKeywords,
  applyMembersOnlyLiveChat,
  addVideoToPlaylist,
  applyLiveBroadcastSeo,
  isBlockedTag,
  blockedTagPatterns,
  endLiveBroadcast,
  getBroadcastStatus,
  getLiveStreamHealth,
  transitionBroadcastToLive,
  getVideoStatistics,
  listActiveBroadcasts,
  listDiscoverableBroadcasts,
  reconcileOrphanedBroadcasts,
  _ytTags,
  _ytText,
  resolveContainsSyntheticMedia,
  setContainsSyntheticMedia,
};
