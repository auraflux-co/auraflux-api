/**
 * Pre-flight checks before pulling a live source (offline→online handoff).
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const { kickPageUrl } = require('./kick_config');

const execFileAsync = promisify(execFile);
const axios = require('axios');
const STREAMLINK = process.env.STREAMLINK_PATH || 'streamlink';
const PROBE_TIMEOUT_MS = parseInt(process.env.LIVE_GRID_STREAM_PROBE_MS || '8000', 10);

function useHelixTwitchProbe() {
  const mode = String(process.env.LIVE_GRID_TWITCH_PROBE || '').trim().toLowerCase();
  if (mode === 'streamlink') return false;
  if (mode === 'helix') return true;
  return String(process.env.RENDER || '').toLowerCase() === 'true'
    || process.env.NODE_ENV === 'staging';
}

/** Helix /streams — reliable on Render; streamlink often false-negative on datacenter IPs. */
async function twitchHelixLive(login, timeoutMs = PROBE_TIMEOUT_MS) {
  const slug = String(login || '').trim().toLowerCase();
  if (!slug) return false;
  const clientId = process.env.TWITCH_CLIENT_ID;
  const token = String(process.env.TWITCH_TOKEN || '').replace(/^oauth:/, '');
  if (!clientId || !token) return streamlinkAvailable(`twitch.tv/${slug}`, timeoutMs);
  try {
    const resp = await axios.get('https://api.twitch.tv/helix/streams', {
      headers: { 'Client-ID': clientId, Authorization: `Bearer ${token}` },
      params: { user_login: [slug], first: 1 },
      timeout: timeoutMs,
    });
    return (resp.data?.data || []).length > 0;
  } catch {
    return streamlinkAvailable(`twitch.tv/${slug}`, timeoutMs);
  }
}

function streamlinkProbeArgs(url) {
  const args = [];
  if (String(url).toLowerCase().includes('kick.com')) args.push('--kick-low-latency');
  if (String(url).toLowerCase().includes('twitch.tv')) {
    args.push('--twitch-disable-ads', '--twitch-low-latency');
  }
  args.push('--stream-url', url, 'best');
  return args;
}

/** True when streamlink can resolve a playable URL (channel is live). */
async function streamlinkAvailable(url, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const { stdout } = await execFileAsync(
      STREAMLINK,
      streamlinkProbeArgs(url),
      { timeout: timeoutMs },
    );
    return Boolean(String(stdout || '').trim());
  } catch {
    return false;
  }
}

async function twitchChannelLive(login, timeoutMs = PROBE_TIMEOUT_MS) {
  if (useHelixTwitchProbe()) return twitchHelixLive(login, timeoutMs);
  const slug = String(login || '').trim().toLowerCase();
  if (!slug) return false;
  return streamlinkAvailable(`twitch.tv/${slug}`, timeoutMs);
}

/** Kick live detection — API first (Render streamlink often false-negative), streamlink fallback. */
async function kickChannelLive(slug, timeoutMs = PROBE_TIMEOUT_MS) {
  const normalized = String(slug || '').trim().toLowerCase();
  if (!normalized) return false;

  try {
    const { fetchKickChannelApi } = require('../clients/kick_live_resolver');
    const data = await fetchKickChannelApi(normalized);
    if (data?.livestream) return true;
    if (data && !data.livestream) return false;
  } catch {
    /* API unreachable — fall through to streamlink */
  }

  const url = kickPageUrl(normalized);
  if (!url) return false;
  return streamlinkAvailable(url, timeoutMs);
}

module.exports = {
  streamlinkAvailable,
  streamlinkProbeArgs,
  twitchHelixLive,
  twitchChannelLive,
  kickChannelLive,
  useHelixTwitchProbe,
  PROBE_TIMEOUT_MS,
};
