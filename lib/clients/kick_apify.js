'use strict';
/**
 * kick_apify.js — Kick channel content via Apify zhorex/kick-scraper actor (CPD-316)
 *
 * Replaces kick_fetch.py Cloudflare bypass for channel browsing. Apify runs on
 * infrastructure not subject to Cloudflare datacenter IP blocks on kick.com.
 *
 * DO NOT use BrightData or Oxylabs for Kick — both block streaming sites at the
 * network policy level. See CPD-316 for full history.
 *
 * Actor: https://apify.com/zhorex/kick-scraper
 * Mode used: channel_videos (clips or VODs by channel name)
 *
 * Env var required: APIFY_API_TOKEN
 * Cost: ~$0.005 per result (~$0.10 per 20-clip browse)
 */

const DEFAULT_LIMIT = 20;
const MAX_LIMIT     = 50;
const ACTOR_ID      = 'zhorex~kick-scraper';
const APIFY_BASE    = 'https://api.apify.com/v2';
const TIMEOUT_S     = 30; // actor timeout in seconds

/**
 * Fetch clips or VODs for a Kick channel via Apify.
 *
 * @param {string} username   - Kick channel slug (e.g. 'xqc')
 * @param {'clips'|'videos'|'all'} type
 * @param {number} limit
 * @returns {Promise<object[]>} Normalized content items
 */
async function fetchKickContent(username, type = 'all', limit = DEFAULT_LIMIT) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_API_TOKEN not set');

  const cap       = Math.min(Math.max(1, limit), MAX_LIMIT);
  const videoType = type === 'vod' ? 'videos' : type === 'clip' ? 'clips' : null;

  if (videoType) {
    return _runActor(username, videoType, cap, token);
  }

  // 'all' — fetch clips and VODs in parallel, merge and sort by date
  const half = Math.ceil(cap / 2);
  const [clipsRes, vodsRes] = await Promise.allSettled([
    _runActor(username, 'clips',   half, token),
    _runActor(username, 'videos',  half, token),
  ]);
  const clips = clipsRes.status  === 'fulfilled' ? clipsRes.value  : [];
  const vods  = vodsRes.status   === 'fulfilled' ? vodsRes.value   : [];
  return [...clips, ...vods]
    .sort((a, b) => ((b.publishedAt || '') > (a.publishedAt || '') ? 1 : -1))
    .slice(0, cap);
}

/**
 * Run the Apify actor synchronously and return normalized items.
 * Uses /run-sync-get-dataset-items — one HTTP call returns all results.
 * @private
 */
async function _runActor(username, videoType, maxResults, token) {
  const url = `${APIFY_BASE}/acts/${ACTOR_ID}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}&timeout=${TIMEOUT_S}&memory=256`;

  const body = JSON.stringify({
    mode:         'channel_videos',
    channelNames: [username.toLowerCase()],
    videoType,
    maxResults,
  });

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal:  AbortSignal.timeout((TIMEOUT_S + 5) * 1000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Apify actor error ${res.status}: ${text.slice(0, 200)}`);
  }

  const items = await res.json();
  if (!Array.isArray(items)) {
    throw new Error(`Apify returned unexpected shape: ${JSON.stringify(items).slice(0, 200)}`);
  }

  return items.map((item) => _normalise(item, username));
}

/**
 * Map Apify zhorex/kick-scraper item to AuraFlux normalized content shape.
 * @private
 */
function _normalise(item, channelSlug) {
  const isVod = item.type === 'video' || item.type === 'vod';

  // Apify returns VOD durations in milliseconds; clip durations in seconds.
  // Heuristic: if duration > 86400 it cannot be seconds (> 24 hours), so treat as ms.
  let duration = typeof item.duration === 'number' ? item.duration : 0;
  if (duration > 86400) duration = Math.round(duration / 1000);

  const clipId  = item.clipId  || String(item.id || '');
  const videoId = item.videoId || String(item.id || '');
  // CDN URL (Apify direct link) — store as cdnUrl for fallback portal0 probing.
  const cdnUrl  = item.videoUrl || item.clipUrl || null;
  // yt-dlp's kick:clips extractor requires kick.com/{channel}/clips/{clipId} format.
  // kick.com/clip/{id} routes to kick:live which fails. Channel slug comes from input.
  const ch = channelSlug || '';
  const pageUrl = isVod
    ? (videoId && ch ? `https://kick.com/${ch}/videos/${videoId}` : cdnUrl)
    : (clipId  && ch ? `https://kick.com/${ch}/clips/${clipId}`   : cdnUrl);

  return {
    id:           item.clipId || item.videoId || String(item.id || ''),
    title:        item.title  || 'Untitled',
    thumbnailUrl: item.thumbnailUrl || null,
    duration,
    publishedAt:  item.createdAt || item.startedAt || null,
    url:          pageUrl || cdnUrl,
    cdnUrl,
    viewCount:    item.views     || 0,
    platform:     'kick',
    contentType:  isVod ? 'vod' : 'clip',
  };
}

module.exports = { fetchKickContent };
