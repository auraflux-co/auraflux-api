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

const YT_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const YT_UPLOAD_BASE = 'https://www.googleapis.com/upload/youtube/v3';

const TOKEN_FILE = path.join(__dirname, '..', '..', 'data', 'youtube_tokens.json');

// ── Token store (file-backed) ────────────────────────────────────────────────

function loadTokens() {
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
  const params = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID || '',
    redirect_uri: redirectUri,
    response_type: 'code',
    // youtube (manage) scope added for videos.update — metadata edits on published videos (CPD-939)
    scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube',
    access_type: 'offline',
    prompt: 'select_account consent',
    state: state || '',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode(code, redirectUri) {
  const res = await axios.post('https://oauth2.googleapis.com/token', {
    code,
    client_id: process.env.YOUTUBE_CLIENT_ID,
    client_secret: process.env.YOUTUBE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  return res.data; // { access_token, refresh_token, expires_in, scope }
}

async function refreshAccessToken(refreshToken) {
  const res = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: process.env.YOUTUBE_CLIENT_ID,
    client_secret: process.env.YOUTUBE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  return res.data;
}

/** Get a valid access token, refreshing from the stored refresh token if needed. */
async function getAccessToken() {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error('YouTube not connected — visit /connect/youtube to authorize the channel');
  }
  const expiresAt = tokens.expires_at ? new Date(tokens.expires_at).getTime() : 0;
  if (tokens.access_token && expiresAt > Date.now() + 60_000) {
    return tokens.access_token;
  }
  const refreshed = await refreshAccessToken(tokens.refresh_token);
  tokens.access_token = refreshed.access_token;
  tokens.expires_at = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString();
  saveTokens(tokens);
  return tokens.access_token;
}

async function getChannelInfo(accessToken) {
  const res = await axios.get(`${YT_API_BASE}/channels?part=snippet&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const ch = res.data?.items?.[0];
  return ch ? { channelId: ch.id, channelTitle: ch.snippet?.title } : null;
}

// ── Publish ──────────────────────────────────────────────────────────────────

/**
 * Upload a video to YouTube via resumable upload, then set the custom thumbnail.
 *
 * @param {object} p
 * @param {string} p.videoSource    — local file path OR public URL (R2)
 * @param {object} p.metadata       — { title, description, tags, categoryId, privacyStatus, publishAt }
 * @param {string} [p.thumbnailUrl] — public URL or local path of custom thumbnail
 * @param {string} [p.jobId]        — log tag
 * @returns {object} { videoId, url, status, thumbnailSet }
 */
async function publish({ videoSource, metadata, thumbnailUrl, jobId = '' }) {
  const accessToken = await getAccessToken();

  const videoMeta = {
    snippet: {
      title: (metadata.title || 'New video').slice(0, 100),
      description: (metadata.description || '').slice(0, 5000),
      tags: (metadata.tags || []).slice(0, 50),
      categoryId: metadata.categoryId || '24',
      defaultLanguage: 'en',
      defaultAudioLanguage: 'en',
    },
    status: {
      privacyStatus: metadata.privacyStatus || 'private',
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: true,
      ...(metadata.publishAt ? { publishAt: metadata.publishAt, privacyStatus: 'private' } : {}),
    },
  };

  // Resumable upload initiation
  const initRes = await axios.post(
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
  const uploadRes = await axios.put(uploadUrl, videoStream, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'video/*',
      ...(videoSize ? { 'Content-Length': videoSize } : {}),
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

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
}

// ---------------------------------------------------------------------------
// YouTube Live (CPD-945 — Live Grid)
// ---------------------------------------------------------------------------

const YT_API = 'https://www.googleapis.com/youtube/v3';

/**
 * Create a reusable RTMP ingest stream.
 * @returns {{ streamId, rtmpUrl }} rtmpUrl is ready for ffmpeg -f flv output
 */
async function createLiveStream({ title = 'ClipzWorld Live Grid ingest' } = {}) {
  const accessToken = await getAccessToken();
  const res = await axios.post(`${YT_API}/liveStreams?part=snippet,cdn,contentDetails`, {
    snippet: { title },
    cdn: { ingestionType: 'rtmp', resolution: '1080p', frameRate: '30fps' },
    contentDetails: { isReusable: true },
  }, { headers: { Authorization: `Bearer ${accessToken}` } });
  const s = res.data;
  const ing = s.cdn?.ingestionInfo || {};
  return {
    streamId: s.id,
    rtmpUrl: `${ing.ingestionAddress}/${ing.streamName}`,
  };
}

/**
 * Create a broadcast, bind it to a stream, and rely on enableAutoStart to go
 * live as soon as RTMP data flows. autoStop is OFF so master-compositor
 * restarts (quadrant swaps) don't end the broadcast.
 * @returns {{ broadcastId, watchUrl }}
 */
async function createLiveBroadcast({ title, description = '', privacyStatus = 'public', streamId }) {
  if (!title || !streamId) throw new Error('createLiveBroadcast: title and streamId required');
  const accessToken = await getAccessToken();
  const res = await axios.post(`${YT_API}/liveBroadcasts?part=snippet,status,contentDetails`, {
    snippet: { title: title.slice(0, 100), description: description.slice(0, 5000), scheduledStartTime: new Date().toISOString() },
    status: { privacyStatus, selfDeclaredMadeForKids: false },
    contentDetails: { enableAutoStart: true, enableAutoStop: false, latencyPreference: 'low' },
  }, { headers: { Authorization: `Bearer ${accessToken}` } });
  const broadcastId = res.data.id;

  await axios.post(`${YT_API}/liveBroadcasts/bind?id=${broadcastId}&part=id&streamId=${encodeURIComponent(streamId)}`,
    null, { headers: { Authorization: `Bearer ${accessToken}` } });

  return { broadcastId, watchUrl: `https://youtube.com/live/${broadcastId}` };
}

/** Update live title and (optionally) description in one snippet update. */
async function updateBroadcastMeta(broadcastId, { title, description } = {}) {
  const accessToken = await getAccessToken();
  const snippet = { title: String(title).slice(0, 100), scheduledStartTime: new Date().toISOString() };
  if (description != null) snippet.description = String(description).slice(0, 5000);
  await axios.put(`${YT_API}/liveBroadcasts?part=snippet`, {
    id: broadcastId,
    snippet,
  }, { headers: { Authorization: `Bearer ${accessToken}` } });
}

/** Update the live title (e.g. "LIVE: jasontheween, stableronaldo +2"). */
async function updateBroadcastTitle(broadcastId, title) {
  return updateBroadcastMeta(broadcastId, { title });
}

/** End the broadcast (VOD stays on the channel). */
async function endLiveBroadcast(broadcastId) {
  const accessToken = await getAccessToken();
  await axios.post(`${YT_API}/liveBroadcasts/transition?id=${broadcastId}&broadcastStatus=complete&part=status`,
    null, { headers: { Authorization: `Bearer ${accessToken}` } });
}

/** lifeCycleStatus: created|ready|testing|live|complete (+ recording details). */
async function getBroadcastStatus(broadcastId) {
  const accessToken = await getAccessToken();
  const res = await axios.get(`${YT_API}/liveBroadcasts?part=status,snippet&id=${broadcastId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } });
  const b = res.data.items?.[0];
  return b ? { lifeCycleStatus: b.status?.lifeCycleStatus, title: b.snippet?.title } : null;
}

module.exports = {
  publish,
  buildAuthUrl,
  exchangeCode,
  getAccessToken,
  getChannelInfo,
  loadTokens,
  saveTokens,
  isConnected,
  createLiveStream,
  createLiveBroadcast,
  updateBroadcastTitle,
  updateBroadcastMeta,
  endLiveBroadcast,
  getBroadcastStatus,
};
