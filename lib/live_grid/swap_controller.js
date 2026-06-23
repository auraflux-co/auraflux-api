'use strict';

/**
 * Staged swap orchestration — hold waiting slate locally until feeder + RTSP stable.
 * Used when LIVE_GRID_STAGED_SWAP=on.
 */

const { rtspHasVideo } = require('./rtsp_probe');
const { quadUrl } = require('./feeders');
const {
  swapDebounceMs,
  swapStableMs,
  swapStableProbeMs,
} = require('./middleware_config');

const SWAPPING = 'swapping';
const LIVE = 'live';

class SwapController {
  /**
   * @param {Object} opts
   * @param {Function} opts.log
   * @param {(q: number, login: string|null) => Promise<void>|void} opts.onRequestReplace
   * @param {(q: number, login: string|null) => void} [opts.onSwapComplete]
   * @param {number} [opts.debounceMs]
   * @param {number} [opts.stableMs]
   */
  constructor(opts = {}) {
    this.log = opts.log || (() => {});
    this.onRequestReplace = opts.onRequestReplace || (async () => {});
    this.onSwapComplete = opts.onSwapComplete || (() => {});
    this.debounceMs = opts.debounceMs ?? swapDebounceMs();
    this.stableMs = opts.stableMs ?? swapStableMs();
    this.stableProbeMs = opts.stableProbeMs ?? swapStableProbeMs();
    /** @type {Map<number, { state: string, login: string|null, since: number, debounceTimer: *, stableTimer: * }>} */
    this._quads = new Map();
    this._replaceTimer = null;
    this._pendingReplace = new Set();
  }

  _quad(q) {
    if (!this._quads.has(q)) {
      this._quads.set(q, {
        state: LIVE,
        login: null,
        since: Date.now(),
        debounceTimer: null,
        stableTimer: null,
      });
    }
    return this._quads.get(q);
  }

  isSwapping(q) {
    return this._quad(q).state === SWAPPING;
  }

  anySwapping() {
    for (const row of this._quads.values()) {
      if (row.state === SWAPPING) return true;
    }
    return false;
  }

  /** Feeder reported logoff — debounce bench fill (no immediate poll storm). */
  onOffline(q, login) {
    const row = this._quad(q);
    row.state = SWAPPING;
    row.login = login || null;
    row.since = Date.now();
    this._pendingReplace.add(q);
    this.log(`swap Q${q + 1} → SWAPPING (${login || 'unknown'}) — debounced replace in ${this.debounceMs / 1000}s`);
    this._scheduleReplace();
  }

  /** Manual swap or poller assignment — mark swapping until feeder stable. */
  onAssignmentChange(q, login) {
    const row = this._quad(q);
    if (row.state === SWAPPING && row.login === login) return;
    row.state = SWAPPING;
    row.login = login || null;
    row.since = Date.now();
    this.log(`swap Q${q + 1} → SWAPPING (assign ${login || 'slate'})`);
    if (login) this._scheduleStableCheck(q, login);
    else this._complete(q, null);
  }

  /** Feeder handoff — channel procs wired. */
  onFeederLive(q, login) {
    if (!this.isSwapping(q)) return;
    this.log(`swap Q${q + 1} feeder live (${login}) — probing RTSP stability`);
    this._scheduleStableCheck(q, login);
  }

  _scheduleReplace() {
    clearTimeout(this._replaceTimer);
    this._replaceTimer = setTimeout(async () => {
      this._replaceTimer = null;
      const quads = [...this._pendingReplace];
      this._pendingReplace.clear();
      if (!quads.length) return;
      this.log(`swap debounce fired — replace poll for quads ${quads.map((x) => x + 1).join(', ')}`);
      for (const q of quads) {
        try {
          await this.onRequestReplace(q, this._quad(q).login);
        } catch (e) {
          this.log(`swap replace Q${q + 1} failed: ${e.message}`);
        }
      }
    }, this.debounceMs);
    this._replaceTimer.unref?.();
  }

  _scheduleStableCheck(q, login) {
    const row = this._quad(q);
    clearTimeout(row.stableTimer);
    const started = Date.now();
    const probe = async () => {
      if (row.state !== SWAPPING) return;
      const ok = await rtspHasVideo(quadUrl(q), 4000);
      if (!ok) {
        if (Date.now() - started < this.stableMs + 15000) {
          row.stableTimer = setTimeout(probe, this.stableProbeMs);
          row.stableTimer.unref?.();
        } else {
          this.log(`swap Q${q + 1} RTSP probe timeout — completing anyway`);
          this._complete(q, login);
        }
        return;
      }
      if (Date.now() - started < this.stableMs) {
        row.stableTimer = setTimeout(probe, this.stableProbeMs);
        row.stableTimer.unref?.();
        return;
      }
      this._complete(q, login);
    };
    row.stableTimer = setTimeout(probe, this.stableProbeMs);
    row.stableTimer.unref?.();
  }

  _complete(q, login) {
    const row = this._quad(q);
    if (row.state !== SWAPPING) return;
    clearTimeout(row.stableTimer);
    row.stableTimer = null;
    row.state = LIVE;
    const ms = Date.now() - row.since;
    this.log(`swap_complete Q${q + 1} (${login || 'slate'}) after ${Math.round(ms / 1000)}s`);
    this.onSwapComplete(q, login);
  }

  stop() {
    clearTimeout(this._replaceTimer);
    this._replaceTimer = null;
    this._pendingReplace.clear();
    for (const row of this._quads.values()) {
      clearTimeout(row.debounceTimer);
      clearTimeout(row.stableTimer);
    }
    this._quads.clear();
  }

  status() {
    const quads = [];
    for (let q = 0; q < 4; q++) {
      const row = this._quads.get(q);
      if (!row) {
        quads.push({ quadrant: q + 1, state: LIVE, login: null, swappingMs: 0 });
        continue;
      }
      quads.push({
        quadrant: q + 1,
        state: row.state,
        login: row.login,
        swappingMs: row.state === SWAPPING ? Date.now() - row.since : 0,
      });
    }
    return {
      anySwapping: this.anySwapping(),
      debounceMs: this.debounceMs,
      stableMs: this.stableMs,
      quads,
    };
  }
}

module.exports = { SwapController, SWAPPING, LIVE };
