/**
 * Live Grid — grid manager (CPD-946)
 *
 * Ties the layers together:
 *   poller (CPD-942) → feeders (CPD-943) → master compositor (CPD-944)
 *     → YouTube Live broadcast (CPD-945)
 *
 * - Poller assignments are applied to the feeders every poll (idempotent).
 * - Any quadrant change triggers a debounced planned master restart —
 *   established RTSP readers don't pick up a swapped publisher (see HOW page).
 * - Broadcast title refreshes on grid changes ("LIVE: a, b +2").
 * - caffeinate held while live so the Mac never sleeps mid-stream.
 */

const { spawn } = require('child_process');
const { LiveGridPoller } = require('./poller');
const { QuadrantFeeders, generateSlate } = require('./feeders');
const { MasterCompositor } = require('./compositor');
const yt = require('../services/youtube_direct');

const SWAP_RESTART_DEBOUNCE_MS = 5_000;

function gridTitle(assignments) {
  const live = assignments.filter(Boolean);
  if (!live.length) return 'ClipzWorld Live Grid';
  const lead = live.slice(0, 2).join(', ');
  const more = live.length > 2 ? ` +${live.length - 2}` : '';
  return `🔴 LIVE: ${lead}${more} — ClipzWorld Grid`;
}

class LiveGridManager {
  constructor(opts = {}) {
    this.log = opts.log || ((m) => console.log(`[live-grid:mgr] ${m}`));
    this.opts = opts;
    this.poller = null;
    this.feeders = null;
    this.master = null;
    this.caffeinate = null;
    this.broadcast = null; // { broadcastId, watchUrl, streamId }
    this.startedAt = null;
    this.running = false;
    this._restartTimer = null;
    this._lastAssignments = [null, null, null, null];
  }

  /**
   * @param {Object} o { privacyStatus='unlisted', title, description, roster, exclude, output }
   *   `output` overrides YouTube entirely (e.g. a file path for rehearsal runs).
   */
  async start(o = {}) {
    if (this.running) throw new Error('live grid already running');
    this.running = true;
    this.startedAt = Date.now();

    await new Promise((res, rej) => generateSlate(e => e ? rej(e) : res()));

    this.poller = new LiveGridPoller({ roster: o.roster, exclude: o.exclude });
    this.feeders = new QuadrantFeeders({ log: this.log });

    // First poll before going live so the grid opens populated, not 4 slates
    const { assignments } = await this.poller.pollOnce();
    this.feeders.applyAssignments(assignments);
    this._lastAssignments = [...assignments];

    let output = o.output;
    if (!output) {
      const stream = await yt.createLiveStream({ title: 'ClipzWorld Live Grid ingest' });
      const broadcast = await yt.createLiveBroadcast({
        title: o.title || gridTitle(assignments),
        description: o.description || 'The biggest live moments from the ClipzWorld roster — four streams, one grid, all live.',
        privacyStatus: o.privacyStatus || 'unlisted',
        streamId: stream.streamId,
      });
      this.broadcast = { ...broadcast, streamId: stream.streamId };
      output = stream.rtmpUrl;
      this.log(`broadcast created: ${broadcast.watchUrl}`);
    }

    this.master = new MasterCompositor({ output, logoPath: o.logoPath, log: this.log });
    // Give the feeders a moment to fill the MediaMTX paths
    await new Promise(r => setTimeout(r, 8000));
    this.master.start();

    this.poller.on('poll', ({ assignments }) => this._onAssignments(assignments));
    this.poller.on('error', (err) => this.log(`poller error (grid unchanged): ${err.message}`));
    this.poller.start();

    this.caffeinate = spawn('caffeinate', ['-dims'], { stdio: 'ignore' });
    this.log('live grid started');
    return this.status();
  }

  _onAssignments(assignments) {
    if (!this.running) return;
    const changed = assignments.some((a, i) => a !== this._lastAssignments[i]);
    this.feeders.applyAssignments(assignments);
    if (!changed) return;
    this._lastAssignments = [...assignments];

    clearTimeout(this._restartTimer);
    this._restartTimer = setTimeout(() => {
      if (!this.running || !this.master) return;
      this.master.restart();
      if (this.broadcast) {
        yt.updateBroadcastTitle(this.broadcast.broadcastId, gridTitle(assignments))
          .catch(e => this.log(`title update failed: ${e.message}`));
      }
    }, SWAP_RESTART_DEBOUNCE_MS);
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this._restartTimer);
    this.poller?.stop();
    this.master?.stop();
    this.feeders?.stopAll();
    if (this.caffeinate) { try { this.caffeinate.kill(); } catch (_) {} }
    if (this.broadcast) {
      try { await yt.endLiveBroadcast(this.broadcast.broadcastId); this.log('broadcast ended'); }
      catch (e) { this.log(`endLiveBroadcast failed: ${e.response?.data?.error?.message || e.message}`); }
    }
    this.log('live grid stopped');
  }

  status() {
    return {
      running: this.running,
      uptimeSec: this.startedAt && this.running ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      broadcast: this.broadcast ? { id: this.broadcast.broadcastId, watchUrl: this.broadcast.watchUrl } : null,
      quadrants: this.feeders ? this.feeders.status() : [],
      poller: this.poller ? this.poller.status() : null,
      master: this.master ? this.master.status() : null,
    };
  }
}

module.exports = { LiveGridManager, gridTitle };
