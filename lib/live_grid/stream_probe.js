/**
 * Pre-flight checks before pulling a live source (offline→online handoff).
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const { kickPageUrl } = require('./kick_config');

const execFileAsync = promisify(execFile);
const STREAMLINK = process.env.STREAMLINK_PATH || 'streamlink';
const PROBE_TIMEOUT_MS = parseInt(process.env.LIVE_GRID_STREAM_PROBE_MS || '8000', 10);

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
  twitchChannelLive,
  kickChannelLive,
  PROBE_TIMEOUT_MS,
};
