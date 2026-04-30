'use strict';
/**
 * lib/publish/adapters/instagram.js — Instagram Graph API direct Reels publish (CPD-34)
 *
 * Contract: publish({ videoPath, metadata, jobSpec, tokens }) → { platformJobId, url, status }
 *
 * OAuth scopes: instagram_business_basic, instagram_business_content_publish
 * Requires Instagram Business account + Meta App Review (2–4 weeks).
 *
 * Flow: Create media container → Poll FINISHED → Publish container
 */

const axios = require('axios');

const IG_API_BASE = 'https://graph.facebook.com/v21.0';

/**
 * Refresh Instagram long-lived token (60-day tokens, refresh within that window).
 */
async function refreshAccessToken(accessToken) {
  const res = await axios.get(`${IG_API_BASE}/refresh_access_token`, {
    params: {
      grant_type: 'ig_refresh_token',
      access_token: accessToken,
    },
  });
  return res.data; // { access_token, token_type, expires_in }
}

/**
 * Publish a Reel to Instagram.
 *
 * @param {object} p
 * @param {string} p.videoPath       — HTTPS URL (required for IG — must be publicly accessible)
 * @param {object} p.metadata        — { caption, coverUrl, shareToFeed, scheduledPublishTime }
 * @param {object} p.tokens          — { accessToken, platformUserId }
 * @param {object} p.jobSpec
 * @returns {object} { platformJobId, url, status }
 */
async function publish({ videoPath, metadata, tokens, jobSpec }) {
  const accessToken = tokens.accessToken;
  const igUserId = tokens.platformUserId;

  if (!igUserId) throw new Error('Instagram: platformUserId (IG Business account ID) not stored');
  if (!videoPath.startsWith('https://')) {
    throw new Error(
      'Instagram: video must be a publicly accessible HTTPS URL (R2 or CDN URL required)'
    );
  }

  const caption = (metadata.caption || jobSpec?.publishCopy?.tiktok?.caption || '').slice(0, 2200);

  // ── Step 1: Create media container ──────────────────────────────────────
  const containerParams = {
    media_type: 'REELS',
    video_url: videoPath,
    caption,
    share_to_feed: metadata.shareToFeed ?? true,
    access_token: accessToken,
    ...(metadata.coverUrl ? { cover_url: metadata.coverUrl } : {}),
    ...(metadata.scheduledPublishTime
      ? {
          published: false,
          scheduled_publish_time: Math.floor(
            new Date(metadata.scheduledPublishTime).getTime() / 1000
          ),
        }
      : {}),
  };

  const containerRes = await axios.post(`${IG_API_BASE}/${igUserId}/media`, containerParams);
  const containerId = containerRes.data?.id;
  if (!containerId)
    throw new Error(`Instagram: no container ID returned — ${JSON.stringify(containerRes.data)}`);

  // ── Step 2: Poll until FINISHED ──────────────────────────────────────────
  await _pollContainer(containerId, accessToken, 24, 10_000);

  // ── Step 3: Publish container ────────────────────────────────────────────
  const publishRes = await axios.post(`${IG_API_BASE}/${igUserId}/media_publish`, {
    creation_id: containerId,
    access_token: accessToken,
  });
  const mediaId = publishRes.data?.id;
  if (!mediaId) throw new Error('Instagram: publish succeeded but no mediaId returned');

  // Get permalink
  let url = null;
  try {
    const permalink = await axios.get(`${IG_API_BASE}/${mediaId}`, {
      params: { fields: 'permalink', access_token: accessToken },
    });
    url = permalink.data?.permalink || null;
  } catch (_e) {
    /* non-fatal */
  }

  return {
    platformJobId: mediaId,
    url,
    status: metadata.scheduledPublishTime ? 'scheduled' : 'published',
  };
}

async function _pollContainer(containerId, accessToken, maxAttempts, delayMs) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const res = await axios.get(`${IG_API_BASE}/${containerId}`, {
      params: { fields: 'status_code,status', access_token: accessToken },
    });
    const sc = res.data?.status_code;
    if (sc === 'FINISHED') return;
    if (sc === 'ERROR' || sc === 'EXPIRED') {
      throw new Error(`Instagram container ${sc}: ${JSON.stringify(res.data?.status)}`);
    }
  }
  throw new Error(`Instagram container polling timed out after ${maxAttempts} attempts`);
}

/**
 * Build OAuth authorization URL for Instagram Business Login.
 */
function buildAuthUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID || '',
    redirect_uri: redirectUri,
    scope: 'instagram_business_basic,instagram_business_content_publish',
    response_type: 'code',
    state: state || '',
  });
  return `https://www.instagram.com/oauth/authorize?${params}`;
}

async function exchangeCode(code, redirectUri) {
  const res = await axios.post('https://api.instagram.com/oauth/access_token', {
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code,
  });
  // Exchange for long-lived token
  const shortLived = res.data?.access_token;
  const longRes = await axios.get(`${IG_API_BASE}/access_token`, {
    params: {
      grant_type: 'ig_exchange_token',
      client_secret: process.env.META_APP_SECRET,
      access_token: shortLived,
    },
  });
  return longRes.data; // { access_token, token_type, expires_in }
}

async function getAccountInfo(accessToken) {
  const res = await axios.get(`${IG_API_BASE}/me`, {
    params: { fields: 'id,username', access_token: accessToken },
  });
  const me = res.data;
  return me ? { platformUserId: me.id, platformHandle: `@${me.username}` } : null;
}

module.exports = { publish, buildAuthUrl, exchangeCode, getAccountInfo, refreshAccessToken };
