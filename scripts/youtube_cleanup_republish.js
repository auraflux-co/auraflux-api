#!/usr/bin/env node
'use strict';
/**
 * One-off: delete orphan YouTube uploads on a brand channel, reset job, republish private now.
 * Usage: node scripts/youtube_cleanup_republish.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios = require('axios');
const https = require('https');
const { loadTokens, saveTokens } = require('../lib/services/token_store');
const { refreshAccessToken } = require('../lib/publish/adapters/youtube');

const YT_API = 'https://www.googleapis.com/youtube/v3';

const CUSTOMER = 'user_3DeZESHSt4pqQtkDuYJoGDicm2q';
const BRAND_ID = 'e561b5bc-d10e-4045-8aa8-1162d636c50a';
const CHANNEL_ID = 'UChmjlPWGrtC-wb4gaNmMvqQ';
const JOB_ID = 'user_3DeZESHSt4pqQtkDuYJoGDicm2q_COMPACT_FETCH_clips_1781226782284';
const TITLE_NEEDLE = "natashaughey's Game-Turning Play";
const API_BASE = process.env.AURAFLUX_E2E_BASE || 'https://auraflux-api.onrender.com';
const E2E = process.env.E2E_AUTH_SECRET;

async function accessTokenForBrand() {
  const tokens = await loadTokens(CUSTOMER, BRAND_ID, 'youtube');
  if (!tokens?.refreshToken) throw new Error('No YouTube tokens for natashaughey');

  let accessToken = tokens.accessToken;
  if (!accessToken || (tokens.tokenExpiry && new Date(tokens.tokenExpiry) < new Date())) {
    const refreshed = await refreshAccessToken(tokens.refreshToken);
    accessToken = refreshed.access_token;
    await saveTokens({
      customerId: CUSTOMER,
      brandId: BRAND_ID,
      platform: 'youtube',
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || tokens.refreshToken,
      tokenExpiry: refreshed.expires_in
        ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
        : tokens.tokenExpiry,
      scope: tokens.scope,
      platformUserId: tokens.platformUserId,
      platformHandle: tokens.platformHandle,
      rawMeta: tokens.rawMeta,
    });
  }
  return accessToken;
}

async function listChannelUploads(accessToken, channelId) {
  const chRes = await axios.get(`${YT_API}/channels`, {
    params: { part: 'contentDetails', id: channelId },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const uploadsPlaylist = chRes.data?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylist) throw new Error(`No uploads playlist for channel ${channelId}`);

  const out = [];
  let pageToken;
  do {
    const res = await axios.get(`${YT_API}/playlistItems`, {
      params: {
        part: 'snippet,status',
        playlistId: uploadsPlaylist,
        maxResults: 50,
        ...(pageToken ? { pageToken } : {}),
      },
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    out.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

async function deleteVideo(accessToken, videoId) {
  await axios.delete(`${YT_API}/videos`, {
    params: { id: videoId },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function resetJobSpec() {
  const db = require('../lib/db');
  const row = await db.loadJobRow(JOB_ID);
  if (!row) throw new Error(`Job not found: ${JOB_ID}`);
  const spec = typeof row.job_spec === 'string' ? JSON.parse(row.job_spec) : { ...row.job_spec };

  delete spec.scheduledPublishAt;
  delete spec.publishResults;
  delete spec.approvedAt;
  spec.status = 'complete';
  spec.staging = true;
  spec.publishStatus = null;
  spec.order = spec.order || {};
  spec.order.publish = spec.order.publish || {};
  delete spec.order.publish.scheduledPublishAt;
  delete spec.order.publish.scheduledAt;
  spec.order.publish.privacyStatus = 'private';

  await db.updateJobSpec(JOB_ID, spec, { force: true });
  console.log('Job spec reset for immediate private publish');
}

function apiPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      `${API_BASE}${path}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer clerk_user_${CUSTOMER}`,
          'X-E2E-Secret': E2E,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(buf) });
          } catch {
            resolve({ status: res.statusCode, body: buf });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function pollPublish(timeoutMs = 900000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await new Promise((resolve, reject) => {
      https
        .get(
          `${API_BASE}/jobs/${encodeURIComponent(JOB_ID)}/staging-assets`,
          {
            headers: {
              Authorization: `Bearer clerk_user_${CUSTOMER}`,
              'X-E2E-Secret': E2E,
            },
          },
          (r) => {
            let buf = '';
            r.on('data', (c) => { buf += c; });
            r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(buf) }));
          }
        )
        .on('error', reject);
    });
    const yt = res.body?.publishResults?.youtube || {};
    console.log('poll', res.body?.publishStatus, yt.platformJobId || yt.failReason || '');
    if (yt.platformJobId) return yt;
    if (yt.failReason || yt.error || res.body?.publishStatus === 'failed') {
      throw new Error(yt.failReason || yt.error || 'publish failed');
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  throw new Error('publish poll timeout');
}

async function main() {
  if (!E2E) throw new Error('E2E_AUTH_SECRET required in .env');

  const accessToken = await accessTokenForBrand();
  const items = await listChannelUploads(accessToken, CHANNEL_ID);
  const targets = items.filter((it) => {
    const title = it.snippet?.title || '';
    return title.includes(TITLE_NEEDLE);
  });

  console.log(`Found ${targets.length} video(s) matching title on channel`);
  for (const it of targets) {
    const vid = it.snippet?.resourceId?.videoId;
    if (!vid) continue;
    try {
      await deleteVideo(accessToken, vid);
      console.log(`Deleted ${vid} — ${it.snippet.title}`);
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(`Failed to delete ${vid}:`, err.response?.data || err.message);
    }
  }

  await resetJobSpec();

  const pub = await apiPost(`/jobs/${encodeURIComponent(JOB_ID)}/approve-publish`, {
    platforms: ['youtube'],
    publishMeta: { privacyStatus: 'private' },
  });
  console.log('approve-publish', pub.status, JSON.stringify(pub.body));
  if (pub.status !== 202 || !pub.body?.accepted) {
    throw new Error(`approve-publish failed: ${pub.status}`);
  }

  const result = await pollPublish();
  console.log('Published private now:', JSON.stringify(result, null, 2));
  console.log(`https://youtu.be/${result.platformJobId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
