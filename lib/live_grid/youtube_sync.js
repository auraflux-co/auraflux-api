/**
 * Live Grid — YouTube broadcast sync (CPD-1030)
 *
 * Local `running: true` is not proof the stream is live on YouTube. With RTMP
 * bypass (reused broadcast id + env ingest URL) ending the broadcast in Studio
 * does not stop the sidecar — ffmpeg keeps pushing to a dead listing.
 *
 * This watchdog polls YouTube's lifeCycleStatus and stops the grid when the
 * broadcast is no longer live/testing, or exposes stale state on /live-grid/status.
 */

const yt = require('../services/youtube_direct');

const DEFAULT_INTERVAL_MS = parseInt(process.env.LIVE_GRID_YOUTUBE_SYNC_MS || '60000', 10);

/** Broadcast is still accepting RTMP / visible as live on YouTube. */
function isYoutubeLiveStatus(lifeCycleStatus) {
  return lifeCycleStatus === 'live' || lifeCycleStatus === 'testing';
}

/** Local encoder should stop — only when YouTube has ended the listing. */
function isYoutubeStaleStatus(lifeCycleStatus) {
  return lifeCycleStatus === 'complete';
}

class YoutubeBroadcastSync {
  /**
   * @param {Object} opts
   * @param {() => string|null} opts.getBroadcastId
   * @param {() => boolean} opts.isRunning
   * @param {(reason: string) => Promise<void>|void} opts.onStale — local grid should stop
   * @param {(info: Object) => void} [opts.onStatus]
   * @param {Function} [opts.log]
   * @param {number} [opts.intervalMs]
   */
  constructor(opts = {}) {
    this.getBroadcastId = opts.getBroadcastId || (() => null);
    this.isRunning = opts.isRunning || (() => false);
    this.onStale = opts.onStale || (async () => {});
    this.onStatus = opts.onStatus || (() => {});
    this.log = opts.log || ((m) => console.log(`[live-grid:yt-sync] ${m}`));
    this.intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
    this.timer = null;
    this.last = null;
    this._busy = false;
  }

  start() {
    if (this.timer) return;
    if (String(process.env.LIVE_GRID_YOUTUBE_SYNC || 'on').toLowerCase() === 'off') {
      this.log('disabled via LIVE_GRID_YOUTUBE_SYNC=off');
      return;
    }
    this.timer = setInterval(() => this._tick().catch(e => this.log(`tick failed: ${e.message}`)), this.intervalMs);
    this.timer.unref?.();
    this.log(`YouTube sync on — polling every ${Math.round(this.intervalMs / 1000)}s`);
    this._tick().catch(() => {});
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async probe() {
    const broadcastId = this.getBroadcastId();
    if (!broadcastId) {
      this.last = { broadcastId: null, lifeCycleStatus: null, liveOnYouTube: null, checkedAt: Date.now() };
      this.onStatus(this.last);
      return this.last;
    }
    if (!yt.isConnected()) {
      this.last = { broadcastId, lifeCycleStatus: null, liveOnYouTube: null, apiUnavailable: true, checkedAt: Date.now() };
      this.onStatus(this.last);
      return this.last;
    }
    const status = await yt.getBroadcastStatus(broadcastId);
    const lifeCycleStatus = status?.lifeCycleStatus || 'unknown';
    const liveOnYouTube = isYoutubeLiveStatus(lifeCycleStatus);
    this.last = {
      broadcastId,
      lifeCycleStatus,
      privacyStatus: status?.privacyStatus || null,
      title: status?.title || null,
      liveOnYouTube,
      staleLocal: this.isRunning() && !liveOnYouTube,
      checkedAt: Date.now(),
    };
    this.onStatus(this.last);
    return this.last;
  }

  async _tick() {
    if (this._busy || !this.isRunning()) return;
    this._busy = true;
    try {
      const info = await this.probe();
      if (info.staleLocal && isYoutubeStaleStatus(info.lifeCycleStatus)) {
        this.log(`YouTube broadcast ${info.broadcastId} is ${info.lifeCycleStatus} — stopping local encoder (stale sidecar)`);
        await this.onStale(`youtube_${info.lifeCycleStatus}`);
      }
    } finally {
      this._busy = false;
    }
  }

  statusSnapshot() {
    return this.last ? { ...this.last } : { broadcastId: this.getBroadcastId(), liveOnYouTube: null, staleLocal: null };
  }
}

module.exports = { YoutubeBroadcastSync, isYoutubeLiveStatus, isYoutubeStaleStatus };
