/**
 * Pre-flight checks before pulling a live source (offline→online handoff).
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const STREAMLINK = process.env.STREAMLINK_PATH || 'streamlink';
const PROBE_TIMEOUT_MS = parseInt(process.env.LIVE_GRID_STREAM_PROBE_MS || '8000', 10);

/** True when streamlink can resolve a playable URL (channel is live). */
async function streamlinkAvailable(url, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const { stdout } = await execFileAsync(
      STREAMLINK,
      ['--stream-url', url, 'best'],
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

module.exports = { streamlinkAvailable, twitchChannelLive, PROBE_TIMEOUT_MS };
