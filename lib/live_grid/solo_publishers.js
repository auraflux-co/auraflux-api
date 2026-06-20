'use strict';

/**
 * CPD-1047 — Per-quadrant solo RTMP publishers (full-screen seat on ClipzWorld YouTube).
 * Reads UDP relay output (preferred) or quad RTSP; staggered start to avoid CPU spike.
 */

const { spawn } = require('child_process');
const { quadUrl } = require('./feeders');
const { rtspHasVideo } = require('./rtsp_probe');
const { resolveLiveGridFfmpeg } = require('./ffmpeg_path');
const { soloRtmpForQuadrant } = require('./solo_listings_env');
const { relayListenUrl, USE_UDP_RELAY } = require('./relays');

const FFMPEG = resolveLiveGridFfmpeg();
const RESTART_MS = parseInt(process.env.LIVE_GRID_SOLO_RESTART_MS || '500', 10);
const RESTART_MAX_MS = parseInt(process.env.LIVE_GRID_SOLO_RESTART_MAX_MS || '4000', 10);
const NUDGE_MS = parseInt(process.env.LIVE_GRID_SOLO_NUDGE_MS || '4000', 10);
const RTSP_WAIT_MS = parseInt(process.env.LIVE_GRID_SOLO_RTSP_WAIT_MS || '25000', 10);
const STAGGER_MS = parseInt(process.env.LIVE_GRID_SOLO_START_STAGGER_MS || '15000', 10);
const UDP_WAIT_MS = parseInt(process.env.LIVE_GRID_SOLO_UDP_WAIT_MS || '30000', 10);

function soloUdpInputEnabled() {
  // Master compositor already listens on relay UDP 5010–5013; solos must use RTSP.
  const explicit = process.env.LIVE_GRID_SOLO_UDP_INPUT;
  if (explicit != null && explicit !== '') {
    return String(explicit).toLowerCase() === 'on';
  }
  return false;
}

function soloInputArgs(q, useUdp) {
  if (useUdp) {
    return [
      '-f', 'mpegts',
      '-fflags', '+genpts+discardcorrupt',
      '-thread_queue_size', '8192',
      '-err_detect', 'ignore_err',
      '-i', relayListenUrl(q),
    ];
  }
  return [
    '-rtsp_transport', 'tcp',
    '-fflags', '+genpts',
    '-i', quadUrl(q),
  ];
}

function soloOutputDims() {
  return {
    w: parseInt(process.env.LIVE_GRID_SOLO_OUTPUT_W || '1280', 10),
    h: parseInt(process.env.LIVE_GRID_SOLO_OUTPUT_H || '720', 10),
    fps: parseInt(process.env.LIVE_GRID_SOLO_FPS || process.env.LIVE_GRID_FPS || '30', 10),
    bitrateK: parseInt(process.env.LIVE_GRID_SOLO_BITRATE_K || '1500', 10),
    audioK: parseInt(process.env.LIVE_GRID_SOLO_AUDIO_BITRATE_K || '128', 10),
  };
}

function soloVideoEncodeArgs() {
  const { w, h, fps, bitrateK, audioK } = soloOutputDims();
  const encoder = process.env.LIVE_GRID_ENCODER || 'libx264';
  const preset = process.env.LIVE_GRID_X264_PRESET || 'ultrafast';
  const gop = fps * 2;
  const maxrate = parseInt(process.env.LIVE_GRID_SOLO_X264_MAXRATE_K || String(bitrateK), 10);
  const bufsize = parseInt(process.env.LIVE_GRID_SOLO_X264_BUFSIZE_K || String(maxrate * 2), 10);
  const vf = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `fps=${fps}`,
  ].join(',');
  const venc = encoder === 'libx264'
    ? ['-c:v', 'libx264', '-preset', preset, '-tune', 'zerolatency', '-g', String(gop),
      '-b:v', `${bitrateK}k`, '-maxrate', `${maxrate}k`, '-bufsize', `${bufsize}k`]
    : ['-c:v', 'h264_videotoolbox', '-b:v', `${bitrateK}k`, '-g', String(gop)];
  return {
    vf,
    venc,
    aenc: ['-c:a', 'aac', '-b:a', `${audioK}k`, '-ar', '48000', '-ac', '2'],
  };
}

class SoloPublishers {
  constructor(opts = {}) {
    this.log = opts.log || ((m) => console.log(`[live-grid:solo] ${m}`));
    this.relayReady = opts.relayReady || (() => false);
    this.useUdpInput = opts.useUdpInput ?? soloUdpInputEnabled();
    this.stopped = true;
    this.started = false;
    this.procs = [null, null, null, null];
    this._gen = [0, 0, 0, 0];
    this.restarts = [0, 0, 0, 0];
    this._nudgeTimer = [null, null, null, null];
    this._staggerTimers = [];
    this._exitBackoff = [RESTART_MS, RESTART_MS, RESTART_MS, RESTART_MS];
    this._currentLogin = [null, null, null, null];
  }

  startAll() {
    this.stopped = false;
    this.started = true;
    for (const t of this._staggerTimers) clearTimeout(t);
    this._staggerTimers = [];
    let n = 0;
    let delay = 0;
    for (let q = 0; q < 4; q++) {
      if (!soloRtmpForQuadrant(q)) continue;
      const seat = q;
      const timer = setTimeout(() => {
        if (!this.stopped && this.started) this.start(seat);
      }, delay);
      timer.unref?.();
      this._staggerTimers.push(timer);
      delay += STAGGER_MS;
      n++;
    }
    const mode = this.useUdpInput ? 'UDP relay' : 'RTSP';
    this.log(`solo publishers armed for ${n}/4 seats (${mode}, ${STAGGER_MS / 1000}s stagger)`);
  }

  start(q) {
    if (q < 0 || q > 3) return;
    if (!soloRtmpForQuadrant(q)) return;
    this._startWhenReady(q, 'start');
  }

  restart(q, login = null) {
    if (!this.started || q < 0 || q > 3) return;
    if (login != null) this._currentLogin[q] = login;
    clearTimeout(this._nudgeTimer[q]);
    this._nudgeTimer[q] = setTimeout(() => {
      this._nudgeTimer[q] = null;
      this.log(`Q${q + 1} solo nudged${login ? ` → ${login}` : ''}`);
      this._startWhenReady(q, 'swap');
    }, NUDGE_MS);
    this._nudgeTimer[q].unref?.();
  }

  async _waitForInput(q, gen) {
    const deadline = Date.now() + (this.useUdpInput ? UDP_WAIT_MS : RTSP_WAIT_MS);
    while (Date.now() < deadline) {
      if (this.stopped || gen !== this._gen[q]) return false;
      if (this.useUdpInput) {
        if (this.relayReady(q)) return true;
      } else if (await rtspHasVideo(quadUrl(q), 3000)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (this.stopped || gen !== this._gen[q]) return false;
    if (this.useUdpInput) return this.relayReady(q);
    return rtspHasVideo(quadUrl(q), 3000);
  }

  async _startWhenReady(q, reason) {
    const rtmp = soloRtmpForQuadrant(q);
    if (!rtmp || this.stopped) return;
    this._kill(q);
    const gen = this._gen[q];
    const ready = await this._waitForInput(q, gen);
    if (this.stopped || gen !== this._gen[q]) return;
    if (!ready) {
      const src = this.useUdpInput ? 'UDP relay' : 'RTSP';
      this.log(`Q${q + 1} solo: ${src} not ready (${reason}) — retry later`);
      setTimeout(() => {
        if (!this.stopped && gen === this._gen[q]) this._startWhenReady(q, `${reason}-retry`);
      }, RESTART_MS * 3);
      return;
    }
    this._spawn(q, gen, rtmp);
  }

  _spawn(q, gen, rtmp) {
    this._exitBackoff[q] = RESTART_MS;
    const { vf, venc, aenc } = soloVideoEncodeArgs();
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      ...soloInputArgs(q, this.useUdpInput),
      '-vf', vf,
      ...venc,
      '-pix_fmt', 'yuv420p',
      ...aenc,
      '-f', 'flv',
      rtmp,
    ];
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.procs[q] = p;
    let errTail = '';
    p.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-500); });
    p.on('exit', (code) => {
      if (this.stopped || gen !== this._gen[q]) return;
      this.restarts[q]++;
      const delay = Math.min(this._exitBackoff[q] * 2, RESTART_MAX_MS);
      this._exitBackoff[q] = delay;
      this.log(`Q${q + 1} solo exited (${code}) — restart #${this.restarts[q]} in ${delay / 1000}s`);
      if (errTail.trim()) this.log(`solo stderr Q${q + 1}: ${errTail.trim().split('\n').slice(-1)[0]}`);
      setTimeout(() => {
        if (!this.stopped && gen === this._gen[q]) this._startWhenReady(q, 'exit');
      }, delay);
    });
    const src = this.useUdpInput ? 'UDP' : 'RTSP';
    this.log(`Q${q + 1} solo (${src}) → ${rtmp.replace(/\/live2\/.+$/, '/live2/…')}`);
  }

  _kill(q) {
    clearTimeout(this._nudgeTimer[q]);
    this._nudgeTimer[q] = null;
    this._gen[q]++;
    const p = this.procs[q];
    if (p) { try { p.kill('SIGKILL'); } catch (_) {} }
    this.procs[q] = null;
  }

  stopAll() {
    this.stopped = true;
    this.started = false;
    for (const t of this._staggerTimers) clearTimeout(t);
    this._staggerTimers = [];
    for (let q = 0; q < 4; q++) this._kill(q);
    this.log('solo publishers stopped');
  }

  status(getLogin) {
    return [0, 1, 2, 3].map((q) => {
      const listing = require('./solo_listings_env').readSoloListingForQuadrant(q);
      const login = typeof getLogin === 'function' ? getLogin(q) : this._currentLogin[q];
      return {
        quadrant: q + 1,
        login: login || null,
        running: !!this.procs[q],
        restarts: this.restarts[q],
        watchUrl: listing?.watchUrl || null,
        broadcastId: listing?.broadcastId || null,
        label: listing?.label || `Screen ${q + 1}`,
        configured: !!listing?.rtmpUrl,
      };
    });
  }
}

module.exports = {
  SoloPublishers,
  soloOutputDims,
  soloVideoEncodeArgs,
  soloUdpInputEnabled,
  soloInputArgs,
};
