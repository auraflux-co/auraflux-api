'use strict';

/**
 * Poll YouTube until broadcast reaches testing/live (CPD-1047).
 * Local ffmpeg running ≠ YouTube accepting ingest.
 */

const yt = require('../services/youtube_direct');
const { isYoutubeLiveStatus } = require('./youtube_sync');

function goLiveWaitEnabled() {
  return String(process.env.LIVE_GRID_YOUTUBE_GO_LIVE_WAIT ?? 'on').toLowerCase() !== 'off';
}

function goLiveWaitMs() {
  return Math.max(5000, parseInt(process.env.LIVE_GRID_YOUTUBE_GO_LIVE_WAIT_MS || '120000', 10));
}

function goLivePollMs() {
  return Math.max(2000, parseInt(process.env.LIVE_GRID_YOUTUBE_GO_LIVE_POLL_MS || '5000', 10));
}

/**
 * @param {string} broadcastId
 * @param {{ timeoutMs?: number, pollMs?: number, log?: (msg: string) => void }} [opts]
 */
async function waitForYoutubeLive(broadcastId, opts = {}) {
  const log = opts.log || (() => {});
  const timeoutMs = opts.timeoutMs ?? goLiveWaitMs();
  const pollMs = opts.pollMs ?? goLivePollMs();
  const started = Date.now();
  let lastStatus = 'unknown';

  if (!broadcastId) {
    return { live: false, lifeCycleStatus: null, elapsedMs: 0, reason: 'no_broadcast_id' };
  }
  if (!yt.isConnected()) {
    return { live: false, lifeCycleStatus: null, elapsedMs: 0, reason: 'youtube_api_unavailable' };
  }

  while (Date.now() - started < timeoutMs) {
    try {
      const status = await yt.getBroadcastStatus(broadcastId);
      lastStatus = status?.lifeCycleStatus || 'unknown';
      if (isYoutubeLiveStatus(lastStatus)) {
        log(`YouTube live confirmed (${lastStatus}) after ${Math.round((Date.now() - started) / 1000)}s`);
        return {
          live: true,
          lifeCycleStatus: lastStatus,
          elapsedMs: Date.now() - started,
          title: status?.title || null,
        };
      }
    } catch (e) {
      log(`YouTube go-live poll failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  return {
    live: false,
    lifeCycleStatus: lastStatus,
    elapsedMs: Date.now() - started,
    reason: 'timeout',
  };
}

module.exports = {
  goLiveWaitEnabled,
  goLiveWaitMs,
  goLivePollMs,
  waitForYoutubeLive,
};
