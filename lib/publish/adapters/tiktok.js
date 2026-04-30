'use strict';
/**
 * lib/publish/adapters/tiktok.js — TikTok Content Posting API direct publish (CPD-34)
 *
 * Contract: publish({ videoPath, metadata, jobSpec, tokens }) → { platformJobId, url, status }
 *
 * OAuth scopes: video.upload, video.publish
 * Requires TikTok for Developers app — submit for audit before production use.
 *
 * Flow: FILE_UPLOAD init → chunk upload → create_post with video_id
 */

const fs = require('fs');
const axios = require('axios');

const TT_API_BASE = 'https://open.tiktokapis.com/v2';
const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB chunks

/**
 * Refresh TikTok access token (24-hour tokens, refresh within that window).
 */
async function refreshAccessToken(refreshToken) {
  const res = await axios.post(`${TT_API_BASE}/oauth/token/`, {
    client_key: process.env.TIKTOK_CLIENT_KEY,
    client_secret: process.env.TIKTOK_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  return res.data?.data;
}

/**
 * Publish a video to TikTok.
 *
 * @param {object} p
 * @param {string} p.videoPath       — local file path or HTTPS URL
 * @param {object} p.metadata        — { caption, privacyLevel, disableComment, disableDuet, disableStitch, aiDisclosure }
 * @param {object} p.tokens          — { accessToken, refreshToken, tokenExpiry }
 * @param {object} p.jobSpec
 * @returns {object} { platformJobId, url, status }
 */
async function publish({ videoPath, metadata, tokens, jobSpec }) {
  let accessToken = tokens.accessToken;

  if (tokens.refreshToken && tokens.tokenExpiry && new Date(tokens.tokenExpiry) < new Date()) {
    const refreshed = await refreshAccessToken(tokens.refreshToken);
    accessToken = refreshed?.access_token || accessToken;
  }

  const caption = (metadata.caption || jobSpec?.publishCopy?.tiktok?.caption || '').slice(0, 2200);
  const isRemoteUrl = videoPath.startsWith('https://');

  // ── Init upload ──────────────────────────────────────────────────────────
  const sourceType = isRemoteUrl ? 'PULL_FROM_URL' : 'FILE_UPLOAD';
  const initBody = {
    post_info: {
      title: caption,
      privacy_level: metadata.privacyLevel || 'SELF_ONLY',
      disable_comment: metadata.disableComment ?? false,
      disable_duet: metadata.disableDuet ?? false,
      disable_stitch: metadata.disableStitch ?? false,
      ...(metadata.aiDisclosure ? { brand_content_toggle: true, brand_organic_toggle: true } : {}),
    },
    source_info:
      sourceType === 'PULL_FROM_URL'
        ? { source: 'PULL_FROM_URL', video_url: videoPath }
        : {
            source: 'FILE_UPLOAD',
            video_size: fs.statSync(videoPath).size,
            chunk_size: CHUNK_SIZE,
            total_chunk_count: Math.ceil(fs.statSync(videoPath).size / CHUNK_SIZE),
          },
  };

  const initRes = await axios.post(`${TT_API_BASE}/post/publish/video/init/`, initBody, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
  });
  const { publish_id, upload_url } = initRes.data?.data || {};
  if (!publish_id) throw new Error(`TikTok init failed: ${JSON.stringify(initRes.data)}`);

  // ── Upload chunks (FILE_UPLOAD only) ────────────────────────────────────
  if (sourceType === 'FILE_UPLOAD' && upload_url) {
    const fileBuffer = fs.readFileSync(videoPath);
    const totalSize = fileBuffer.length;
    let offset = 0;
    let chunkIdx = 0;
    while (offset < totalSize) {
      const chunk = fileBuffer.slice(offset, offset + CHUNK_SIZE);
      const end = Math.min(offset + CHUNK_SIZE - 1, totalSize - 1);
      await axios.put(upload_url, chunk, {
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${offset}-${end}/${totalSize}`,
          'Content-Length': chunk.length,
        },
        maxBodyLength: Infinity,
      });
      offset += CHUNK_SIZE;
      chunkIdx++;
    }
  }

  // For PULL_FROM_URL, TikTok fetches async — poll status
  if (sourceType === 'PULL_FROM_URL') {
    await _pollStatus(publish_id, accessToken, 30, 5000);
  }

  return {
    platformJobId: publish_id,
    url: null, // TikTok doesn't return a direct post URL via API
    status: metadata.privacyLevel === 'SELF_ONLY' ? 'private' : 'published',
  };
}

async function _pollStatus(publishId, accessToken, maxAttempts, delayMs) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const res = await axios.post(
      `${TT_API_BASE}/post/publish/status/fetch/`,
      { publish_id: publishId },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
      }
    );
    const st = res.data?.data?.status;
    if (st === 'PUBLISH_COMPLETE') return;
    if (st === 'FAILED')
      throw new Error(`TikTok publish failed: ${JSON.stringify(res.data?.data?.fail_reason)}`);
  }
  throw new Error(`TikTok publish timed out after ${maxAttempts} polls`);
}

/**
 * Build OAuth authorization URL (PKCE flow).
 */
function buildAuthUrl(redirectUri, state, codeChallenge) {
  const params = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY || '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'video.upload,video.publish',
    state: state || '',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${params}`;
}

async function exchangeCode(code, redirectUri, codeVerifier) {
  const res = await axios.post(`${TT_API_BASE}/oauth/token/`, {
    client_key: process.env.TIKTOK_CLIENT_KEY,
    client_secret: process.env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  return res.data?.data;
}

async function getCreatorInfo(accessToken) {
  const res = await axios.post(
    `${TT_API_BASE}/post/publish/creator_info/query/`,
    {},
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
    }
  );
  const info = res.data?.data;
  return info
    ? { platformUserId: info.creator_id, platformHandle: `@${info.creator_username}` }
    : null;
}

module.exports = { publish, buildAuthUrl, exchangeCode, getCreatorInfo, refreshAccessToken };
