'use strict';
/**
 * Kick live playback resolver (CPD-1065)
 *
 * Resolves a Kick channel slug → signed HLS playback_url for live grid ingest.
 * Render/datacenter IPs are blocked on kick.com; resolution uses (in order):
 *   1. kick_fetch.py (curl_cffi TLS) — optional KICK_PROXY_URL / APIFY_PROXY_PASSWORD
 *   2. Apify zhorex/kick-scraper channel_details — live metadata only (no playback URL)
 */

const path = require('path');
const { spawn } = require('child_process');

const KICK_FETCH_PY = path.join(__dirname, 'kick_fetch.py');
const KICK_CHANNEL_API = 'https://kick.com/api/v2/channels';

function buildApifyProxyUrl() {
  if (process.env.KICK_PROXY_URL) return process.env.KICK_PROXY_URL;
  const proxyPassword = process.env.APIFY_PROXY_PASSWORD;
  if (!proxyPassword) return '';
  return `http://auto:${encodeURIComponent(proxyPassword)}@proxy.apify.com:8000`;
}

function spawnKickFetch(url, params = {}) {
  return new Promise((resolve, reject) => {
    const args = [KICK_FETCH_PY, url];
    if (Object.keys(params).length) args.push(JSON.stringify(params));
    const proxyUrl = buildApifyProxyUrl();
    const env = { ...process.env };
    if (proxyUrl) env.KICK_PROXY_URL = proxyUrl;

    const proc = spawn('python3', args, { timeout: 25000, env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', () => {
      if (!stdout.trim()) {
        return reject(new Error(`kick_fetch.py empty output: ${stderr.slice(0, 200)}`));
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(`kick_fetch.py invalid JSON: ${stdout.slice(0, 200)}`));
      }
    });
    proc.on('error', reject);
  });
}

/** @returns {Promise<object|null>} Kick /api/v2/channels/{slug} body */
async function fetchKickChannelApi(slug) {
  const url = `${KICK_CHANNEL_API}/${encodeURIComponent(String(slug).toLowerCase())}`;
  const result = await spawnKickFetch(url);
  if (result.status === 404) return null;
  if (result.status !== 200) {
    throw new Error(result.error || `Kick API HTTP ${result.status}`);
  }
  return result.data || null;
}

/**
 * Resolve live playback URL for a Kick channel.
 * @param {string} slug
 * @returns {Promise<{ slug: string, isLive: boolean, playbackUrl: string|null, title: string|null, viewers: number }>}
 */
async function resolveKickLivePlayback(slug) {
  const normalized = String(slug || '').trim().toLowerCase();
  if (!normalized) throw new Error('Kick slug required');

  try {
    const data = await fetchKickChannelApi(normalized);
    if (data?.livestream && data.playback_url) {
      return {
        slug: normalized,
        isLive: true,
        playbackUrl: data.playback_url,
        title: data.livestream.session_title || data.livestream.title || null,
        viewers: data.livestream.viewer_count || 0,
        source: 'kick_api',
      };
    }
    if (data && !data.livestream) {
      return { slug: normalized, isLive: false, playbackUrl: null, title: null, viewers: 0, source: 'kick_api' };
    }
  } catch (err) {
    if (process.env.APIFY_API_TOKEN) {
      const { fetchKickChannelDetails } = require('./kick_apify');
      const details = await fetchKickChannelDetails(normalized);
      return {
        slug: normalized,
        isLive: !!details?.isLive,
        playbackUrl: null,
        title: details?.currentStreamTitle || null,
        viewers: details?.currentViewers || 0,
        source: 'apify_metadata',
        error: err.message,
      };
    }
    throw err;
  }

  if (process.env.APIFY_API_TOKEN) {
    const { fetchKickChannelDetails } = require('./kick_apify');
    const details = await fetchKickChannelDetails(normalized);
    return {
      slug: normalized,
      isLive: !!details?.isLive,
      playbackUrl: null,
      title: details?.currentStreamTitle || null,
      viewers: details?.currentViewers || 0,
      source: 'apify_metadata',
    };
  }

  return { slug: normalized, isLive: false, playbackUrl: null, title: null, viewers: 0, source: 'none' };
}

function isKickPageUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return u.hostname.replace(/^www\./, '') === 'kick.com';
  } catch {
    return false;
  }
}

function isKickPlaybackUrl(url) {
  const s = String(url || '').toLowerCase();
  return s.includes('live-video.net') || /\.m3u8(\?|$)/.test(s);
}

function kickSlugFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts[0] ? parts[0].toLowerCase() : null;
  } catch {
    return null;
  }
}

module.exports = {
  resolveKickLivePlayback,
  fetchKickChannelApi,
  buildApifyProxyUrl,
  isKickPageUrl,
  isKickPlaybackUrl,
  kickSlugFromUrl,
};
