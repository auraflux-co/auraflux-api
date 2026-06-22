'use strict';

/**
 * CPD-1047 — Per-quadrant solo RTMP publishers (full-screen seat on ClipzWorld YouTube).
 * Reads UDP relay output (preferred) or quad RTSP; staggered start to avoid CPU spike.
 */

const { spawn } = require('child_process');
const { quadUrl } = require('./feeders');
const { rtspHasVideo } = require('./rtsp_probe');
const { resolveLiveGridFfmpeg } = require('./ffmpeg_path');
const { soloRtmpForQuadrant, poolSize } = require('./solo_listings_env');
const { soloSeatActive, readSoloSeatInt } = require('./solo_focus');
const { resolveRtmpForQuadrant, hasRtmpTarget, streamerLockEnabled, resolveSoloEncodeSeat, poolSlotForLogin } = require('./solo_streamer_registry');
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
    '-fflags', '+genpts+discardcorrupt',
    '-i', quadUrl(q),
  ];
}

function soloOutputDims(q = null, login = null) {
  const global = {
    w: parseInt(process.env.LIVE_GRID_SOLO_OUTPUT_W || '1280', 10),
    h: parseInt(process.env.LIVE_GRID_SOLO_OUTPUT_H || '720', 10),
    fps: parseInt(process.env.LIVE_GRID_SOLO_FPS || process.env.LIVE_GRID_FPS || '30', 10),
    bitrateK: parseInt(process.env.LIVE_GRID_SOLO_BITRATE_K || '1500', 10),
    audioK: parseInt(process.env.LIVE_GRID_SOLO_AUDIO_BITRATE_K || '128', 10),
  };
  if (q == null && login == null) return global;
  const encodeSeat = resolveSoloEncodeSeat(q, login);
  return {
    w: readSoloSeatInt(encodeSeat, 'OUTPUT_W', global.w),
    h: readSoloSeatInt(encodeSeat, 'OUTPUT_H', global.h),
    fps: readSoloSeatInt(encodeSeat, 'FPS', global.fps),
    bitrateK: readSoloSeatInt(encodeSeat, 'BITRATE_K', global.bitrateK),
    audioK: readSoloSeatInt(encodeSeat, 'AUDIO_BITRATE_K', global.audioK),
    poolSlot: poolSlotForLogin(login) || (encodeSeat + 1),
    encodeSeat: encodeSeat + 1,
  };
}

function soloVideoEncodeArgs(q = null, login = null) {
  const { w, h, fps, bitrateK, audioK } = soloOutputDims(q, login);
  const encodeSeat = resolveSoloEncodeSeat(q, login);
  const encoder = process.env.LIVE_GRID_ENCODER || 'libx264';
  const preset = process.env.LIVE_GRID_X264_PRESET || 'ultrafast';
  const gop = fps * 2;
  const maxrate = encodeSeat != null
    ? readSoloSeatInt(encodeSeat, 'X264_MAXRATE_K', readSoloSeatInt(encodeSeat, 'BITRATE_K', bitrateK))
    : parseInt(process.env.LIVE_GRID_SOLO_X264_MAXRATE_K || String(bitrateK), 10);
  const bufsize = encodeSeat != null
    ? readSoloSeatInt(encodeSeat, 'X264_BUFSIZE_K', maxrate * 2)
    : parseInt(process.env.LIVE_GRID_SOLO_X264_BUFSIZE_K || String(maxrate * 2), 10);
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
    const n = poolSize();
    this.log = opts.log || ((m) => console.log(`[live-grid:solo] ${m}`));
    this.relayReady = opts.relayReady || (() => false);
    this.useUdpInput = opts.useUdpInput ?? soloUdpInputEnabled();
    this.stopped = true;
    this.started = false;
    this.procs = Array.from({ length: n }, () => null);
    this._gen = Array.from({ length: n }, () => 0);
    this.restarts = Array.from({ length: n }, () => 0);
    this._nudgeTimer = Array.from({ length: n }, () => null);
    this._staggerTimers = [];
    this._exitBackoff = Array.from({ length: n }, () => RESTART_MS);
    this._currentLogin = Array.from({ length: n }, () => null);
  }

  startAll(assignments = null) {
    this.stopped = false;
    this.started = true;
    if (Array.isArray(assignments)) {
      for (let q = 0; q < poolSize(); q++) this._currentLogin[q] = assignments[q] || null;
    }
    for (const t of this._staggerTimers) clearTimeout(t);
    this._staggerTimers = [];
    let n = 0;
    let delay = 0;
    for (let q = 0; q < poolSize(); q++) {
      const login = this._currentLogin[q];
      if (!hasRtmpTarget(q, login) || !soloSeatActive(q)) continue;
      const seat = q;
      const timer = setTimeout(() => {
        if (!this.stopped && this.started) this.start(seat, this._currentLogin[seat]);
      }, delay);
      timer.unref?.();
      this._staggerTimers.push(timer);
      delay += STAGGER_MS;
      n++;
    }
    const mode = this.useUdpInput ? 'UDP relay' : 'RTSP';
    const lockNote = streamerLockEnabled() ? ', streamer-locked URLs' : '';
    this.log(`solo publishers armed for ${n}/${poolSize()} seats (${mode}, ${STAGGER_MS / 1000}s stagger${lockNote})`);
  }

  start(q, login = null) {
    if (q < 0 || q >= poolSize()) return;
    if (login != null) this._currentLogin[q] = login;
    if (!hasRtmpTarget(q, this._currentLogin[q]) || !soloSeatActive(q)) return;
    this._startWhenReady(q, 'start');
  }

  restart(q, login = null) {
    if (!this.started || q < 0 || q >= poolSize()) return;
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
    const login = this._currentLogin[q];
    const rtmp = resolveRtmpForQuadrant(q, login);
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
    const login = this._currentLogin[q];
    const { vf, venc, aenc } = soloVideoEncodeArgs(q, login);
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      ...soloInputArgs(q, this.useUdpInput),
      '-vf', vf,
      ...venc,
      '-pix_fmt', 'yuv420p',
      ...aenc,
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize',
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
    const loginTag = login ? ` [${login}]` : '';
    this.log(`Q${q + 1} solo${loginTag} (${src}) → ${rtmp.replace(/\/live2\/.+$/, '/live2/…')}`);
  }

  _kill(q) {
    clearTimeout(this._nudgeTimer[q]);
    this._nudgeTimer[q] = null;
    this._gen[q]++;
    const p = this.procs[q];
    if (p) { try { p.kill('SIGKILL'); } catch (_) {} }
    this.procs[q] = null;
  }

  stopSeat(q) {
    if (q < 0 || q >= poolSize()) return;
    this._kill(q);
    this.log(`Q${q + 1} solo stopped (focus / operator)`);
  }

  stopAll() {
    this.stopped = true;
    this.started = false;
    for (const t of this._staggerTimers) clearTimeout(t);
    this._staggerTimers = [];
    for (let q = 0; q < poolSize(); q++) this._kill(q);
    this.log('solo publishers stopped');
  }

  status(getLogin) {
    const { watchUrlForLogin, broadcastIdForLogin, getBinding, streamerLockEnabled: lockOn } = require('./solo_streamer_registry');
    return Array.from({ length: poolSize() }, (_, q) => {
      const listing = require('./solo_listings_env').readSoloListingForQuadrant(q);
      const login = typeof getLogin === 'function' ? getLogin(q) : this._currentLogin[q];
      const lg = login ? String(login).toLowerCase().replace(/^@/, '') : null;
      const binding = lockOn() && lg ? getBinding(lg) : null;
      return {
        quadrant: q + 1,
        login: login || null,
        running: !!this.procs[q],
        restarts: this.restarts[q],
        watchUrl: binding?.watchUrl || listing?.watchUrl || null,
        broadcastId: binding?.broadcastId || listing?.broadcastId || null,
        label: binding ? `@${binding.login}` : (listing?.label || `Screen ${q + 1}`),
        configured: lockOn() ? !!binding?.rtmpUrl : !!listing?.rtmpUrl,
        poolSlot: binding?.slot || null,
        streamerLocked: !!binding,
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
