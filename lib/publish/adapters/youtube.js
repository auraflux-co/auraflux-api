'use strict';
/**
 * lib/publish/adapters/youtube.js — YouTube Data API v3 direct upload (CPD-33)
 *
 * Contract (from lib/publish/index.js):
 *   publish({ videoPath, metadata, jobSpec, tokens }) → { platformJobId, url, status }
 *
 * OAuth scopes required: https://www.googleapis.com/auth/youtube.upload
 * Quota cost: ~1,600 units per video upload + 50 per thumbnail set
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { trackYouTubeQuota, assertYouTubeQuota } = require('../../services/token_store');

const YT_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const UPLOAD_UNITS = 1600;
const THUMB_UNITS = 50;

/**
 * Refresh a YouTube access token using the refresh token.
 * @param {string} refreshToken
 * @returns {object} { access_token, expires_in }
 */
async function refreshAccessToken(refreshToken) {
  const res = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: process.env.YOUTUBE_CLIENT_ID,
    client_secret: process.env.YOUTUBE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  return res.data;
}

/**
 * Upload a video to YouTube via resumable upload.
 *
 * @param {object} p
 * @param {string} p.videoPath    — local file path or Google Drive URL
 * @param {object} p.metadata     — { title, description, tags, categoryId, privacyStatus, publishAt }
 * @param {string} p.accessToken
 * @param {string} p.customerId   — for quota tracking
 * @param {string} [p.thumbnailPath]
 * @returns {object} { videoId, url, status }
 */
async function publish({ videoPath, metadata, tokens, jobSpec }) {
  const customerId = jobSpec?.customerId;

  // Quota guard — 1,600 units per upload, 50 per thumbnail
  const thumbPath = metadata.thumbnailPath || jobSpec?.thumbnailUrl;
  const totalUnits = UPLOAD_UNITS + (thumbPath ? THUMB_UNITS : 0);
  if (customerId) await assertYouTubeQuota(customerId, totalUnits);

  let accessToken = tokens.accessToken;

  // Refresh if expired
  if (tokens.refreshToken && tokens.tokenExpiry && new Date(tokens.tokenExpiry) < new Date()) {
    const refreshed = await refreshAccessToken(tokens.refreshToken);
    accessToken = refreshed.access_token;
  }

  const videoMeta = {
    snippet: {
      title: (metadata.title || jobSpec?.publishCopy?.youtube?.title || jobSpec?.templateName || 'New video').slice(
        0,
        100
      ),
      description: (metadata.description || jobSpec?.publishCopy?.youtube?.description || '').slice(
        0,
        5000
      ),
      tags: (metadata.tags || []).slice(0, 500 / 10), // rough tag budget
      categoryId: metadata.categoryId || '22', // People & Blogs
    },
    status: {
      privacyStatus: metadata.privacyStatus || 'private',
      selfDeclaredMadeForKids: false,
      ...(metadata.publishAt ? { publishAt: metadata.publishAt } : {}),
    },
  };

  // ── Resumable upload initiation ──────────────────────────────────────────
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

  // ── Stream video to upload URL ───────────────────────────────────────────
  let videoStream;
  let videoSize;

  if (videoPath.startsWith('http')) {
    // Remote URL — download first (Drive URL from job)
    const dlRes = await axios.get(videoPath, { responseType: 'stream' });
    videoStream = dlRes.data;
    videoSize = parseInt(dlRes.headers['content-length'] || '0', 10);
  } else {
    videoStream = fs.createReadStream(videoPath);
    videoSize = fs.statSync(videoPath).size;
  }

  const uploadRes = await axios.put(uploadUrl, videoStream, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'video/*',
      'Content-Length': videoSize,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  const videoId = uploadRes.data?.id;
  if (!videoId) throw new Error('YouTube: upload succeeded but no videoId returned');

  // ── Track quota ──────────────────────────────────────────────────────────
  if (customerId) await trackYouTubeQuota(customerId, UPLOAD_UNITS).catch(() => {});

  // ── Set thumbnail if available ───────────────────────────────────────────
  if (thumbPath) {
    try {
      let thumbStream;
      if (thumbPath.startsWith('http')) {
        const tRes = await axios.get(thumbPath, { responseType: 'stream' });
        thumbStream = tRes.data;
      } else {
        thumbStream = fs.createReadStream(thumbPath);
      }
      await axios.post(`${YT_API_BASE}/thumbnails/set?videoId=${videoId}`, thumbStream, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'image/jpeg' },
      });
      if (customerId) await trackYouTubeQuota(customerId, THUMB_UNITS).catch(() => {});
    } catch (_e) {
      // Non-fatal — video uploaded, thumbnail optional
    }
  }

  return {
    platformJobId: videoId,
    url: `https://youtu.be/${videoId}`,
    status: metadata.privacyStatus === 'private' ? 'private' : 'published',
  };
}

/**
 * Build the OAuth authorization URL for YouTube.
 * Redirect user to this URL to start the OAuth flow.
 */
function buildAuthUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID || '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope:
      'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    access_type: 'offline',
    prompt: 'select_account consent',
    state: state || '',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
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

/**
 * Get the authenticated user's YouTube channel info.
 */
async function getChannelInfo(accessToken) {
  const res = await axios.get(`${YT_API_BASE}/channels?part=snippet&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const ch = res.data?.items?.[0];
  return ch ? { platformUserId: ch.id, platformHandle: ch.snippet?.title } : null;
}

module.exports = { publish, buildAuthUrl, exchangeCode, getChannelInfo, refreshAccessToken };
