'use strict';

/**
 * Delivery middleware — reads composed local HLS, pushes long-lived RTMP to YouTube.
 * Active when LIVE_GRID_OUTPUT_MIDDLEWARE=on (compositor writes HLS only).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolveLiveGridFfmpeg } = require('./ffmpeg_path');
const { hlsPreviewLive } = require('./local_preview');
const { restreamerHoldEnabled } = require('./middleware_config');

const FFMPEG = resolveLiveGridFfmpeg();
const RESTART_DELAY_MS = 3_000;
const HLS_WAIT_MS = parseInt(process.env.LIVE_GRID_RESTREAMER_HLS_WAIT_MS || '45000', 10);
const HLS_POLL_MS = 500;

function buildRestreamerArgs(hlsPath, rtmpUrl) {
  const isRemote = /^https?:\/\//i.test(String(hlsPath || ''));
  const args = ['-hide_banner', '-loglevel', 'warning'];
  const lagSegs = parseInt(process.env.LIVE_GRID_RESTREAMER_HLS_LAG || '3', 10);

  if (isRemote) {
    args.push(
      '-re',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-fflags', '+genpts+discardcorrupt',
    );
  } else {
    // Local growing playlist: stay N segments behind live edge, then pace at realtime.
    // Without lag+-re, ffmpeg reads all available segments instantly → YouTube burst then
    // starve (~5–10s cutouts). Lag buffer keeps -re from outrunning compositor.
    args.push(
      '-fflags', '+genpts+discardcorrupt+igndts',
      '-probesize', '32M',
      '-analyzeduration', '5000000',
    );
    if (lagSegs > 0) {
      args.push('-live_start_index', String(-lagSegs));
      args.push('-re');
    }
  }

  args.push('-i', hlsPath);

  args.push(
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    rtmpUrl,
  );
  if (restreamerHoldEnabled()) {
    // Future: alternate input on swap hold — flag reserved for Phase 2
  }
  return args;
}

function waitForHls(hlsPath, timeoutMs = HLS_WAIT_MS) {
  return new Promise((resolve) => {
    const dir = path.dirname(hlsPath);
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (hlsPreviewLive(3000)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, HLS_POLL_MS);
    };
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
    tick();
  });
}

class GridRestreamer {
  /**
   * @param {Object} opts
   * @param {string} opts.hlsPath
   * @param {string} opts.rtmpUrl
   * @param {Function} [opts.log]
   */
  constructor(opts = {}) {
    this.hlsPath = opts.hlsPath;
    this.rtmpUrl = opts.rtmpUrl;
    this.log = opts.log || ((m) => console.log(`[live-grid:restreamer] ${m}`));
    this.proc = null;
    this.running = false;
    this.startedAt = null;
    this.restarts = 0;
    this._restartTimer = null;
    this._hold = false;
  }

  setHold(active) {
    this._hold = !!active;
    if (this._hold) this.log('delivery hold requested (restreamer continues last HLS segment stream)');
  }

  async start() {
    if (this.proc || this.running) return;
    this.running = true;
    const ready = await waitForHls(this.hlsPath);
    if (!this.running) return;
    if (!ready) {
      this.log(`HLS not live at ${this.hlsPath} — starting restreamer anyway (will reconnect)`);
    }
    this._spawn();
  }

  _spawn() {
    if (!this.running) return;
    const args = buildRestreamerArgs(this.hlsPath, this.rtmpUrl);
    this.log(`starting restreamer → YouTube (${this.hlsPath})`);
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = p;
    this.startedAt = Date.now();

    let errTail = '';
    p.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-1500); });

    p.on('exit', (code) => {
      this.proc = null;
      if (!this.running) return;
      this.restarts++;
      this.log(`restreamer exited (${code}) — restart #${this.restarts} in ${RESTART_DELAY_MS / 1000}s`);
      if (errTail.trim()) {
        this.log(`restreamer stderr: ${errTail.trim().split('\n').slice(-2).join(' | ')}`);
      }
      clearTimeout(this._restartTimer);
      this._restartTimer = setTimeout(() => this._spawn(), RESTART_DELAY_MS);
      this._restartTimer.unref?.();
    });
  }

  stop() {
    this.running = false;
    clearTimeout(this._restartTimer);
    this._restartTimer = null;
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch (_) {}
      this.proc = null;
    }
    this.log('restreamer stopped');
  }

  status() {
    return {
      running: this.running && !!this.proc,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt && this.proc
        ? Math.round((Date.now() - this.startedAt) / 1000)
        : 0,
      restarts: this.restarts,
      hlsPath: this.hlsPath,
      hold: this._hold,
      rtmpMasked: this.rtmpUrl ? this.rtmpUrl.replace(/\/live2\/.+$/, '/live2/…') : null,
    };
  }
}

module.exports = {
  GridRestreamer,
  buildRestreamerArgs,
  waitForHls,
};
