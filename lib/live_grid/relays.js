/**
 * Live Grid — per-quadrant UDP relays (CPD-1006)
 *
 * Small ffmpeg processes bridge MediaMTX RTSP → fixed localhost UDP ports.
 * The master compositor reads those UDP URLs instead of RTSP directly, so
 * when a feeder swaps streamers only the relay restarts (~1 tile blip) —
 * the YouTube RTMP master keeps running.
 *
 *   feeder → SRT → MediaMTX → rtsp://localhost:8554/quadN
 *                                    ↓ relay (restarts on swap/EOF)
 *                            udp://127.0.0.1:5010+N  (mpegts)
 *                                    ↓
 *                              master compositor
 */

const { spawn } = require('child_process');
const { quadUrl } = require('./feeders');
const { rtspHasVideo } = require('./rtsp_probe');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const USE_UDP_RELAY = String(process.env.LIVE_GRID_UDP_RELAY || 'on').toLowerCase() !== 'off';
const UDP_BASE_PORT = parseInt(process.env.LIVE_GRID_UDP_BASE_PORT || '5010', 10);
const RELAY_RESTART_MS = parseInt(process.env.LIVE_GRID_RELAY_RESTART_MS || '500', 10);
const RELAY_RESTART_MAX_MS = parseInt(process.env.LIVE_GRID_RELAY_RESTART_MAX_MS || '3000', 10);
const RELAY_SWAP_RESTART_MS = parseInt(process.env.LIVE_GRID_RELAY_SWAP_RESTART_MS || '250', 10);
const RELAY_RTSP_WAIT_MS = parseInt(process.env.LIVE_GRID_RELAY_RTSP_WAIT_MS || '25000', 10);
const RELAY_NUDGE_DEBOUNCE_MS = parseInt(process.env.LIVE_GRID_RELAY_NUDGE_MS || '4000', 10);
const RELAY_WAIT_POLL_MS = 500;
const RELAY_TRANSCODE = String(process.env.LIVE_GRID_RELAY_TRANSCODE || 'off').toLowerCase() === 'on';
const RELAY_TRANSCODE_FPS = parseInt(process.env.LIVE_GRID_RELAY_FPS || process.env.LIVE_GRID_FPS || '24', 10);
const RELAY_SCALE_W = parseInt(process.env.LIVE_GRID_RELAY_SCALE_W || '640', 10);
const RELAY_SCALE_H = parseInt(process.env.LIVE_GRID_RELAY_SCALE_H || '360', 10);
const RELAY_BITRATE_K = parseInt(process.env.LIVE_GRID_RELAY_BITRATE_K || '1200', 10);

/** Output args for RTSP→UDP relay — transcode video only; copy audio (Twitch AAC is already fine). */
function relayOutputArgs() {
  if (!RELAY_TRANSCODE) return ['-c', 'copy'];
  const gop = RELAY_TRANSCODE_FPS * 2;
  return [
    '-map', '0:v', '-map', '0:a?',
    '-vf', `scale=${RELAY_SCALE_W}:${RELAY_SCALE_H}:flags=fast_bilinear:force_original_aspect_ratio=increase,crop=${RELAY_SCALE_W}:${RELAY_SCALE_H},fps=${RELAY_TRANSCODE_FPS}:round=near,setsar=1`,
    '-c:v', 'h264_videotoolbox', '-profile:v', 'high', '-b:v', `${RELAY_BITRATE_K}k`, '-g', String(gop),
    '-c:a', 'copy',
    '-max_muxing_queue_size', '4096',
  ];
}

function relayPublishUrl(q) {
  return `udp://127.0.0.1:${UDP_BASE_PORT + q}?pkt_size=1316`;
}

function relayListenUrl(q) {
  return `udp://127.0.0.1:${UDP_BASE_PORT + q}?overrun_nonfatal=1&fifo_size=50000000`;
}

/** Master compositor input args for quadrant q. */
function quadMasterInputArgs(q) {
  if (USE_UDP_RELAY) {
    return [
      '-f', 'mpegts',
      '-fflags', '+genpts+discardcorrupt',
      '-thread_queue_size', '8192',
      '-err_detect', 'ignore_err',
      '-i', relayListenUrl(q),
    ];
  }
  return ['-rtsp_transport', 'tcp', '-i', quadUrl(q)];
}

class QuadRelays {
  constructor(opts = {}) {
    this.log = opts.log || ((m) => console.log(`[live-grid:relay] ${m}`));
    this.stopped = false;
    this.procs = [null, null, null, null];
    this._gen = [0, 0, 0, 0];
    this.restarts = [0, 0, 0, 0];
    this._nudgeTimer = [null, null, null, null];
    this._exitBackoff = [RELAY_RESTART_MS, RELAY_RESTART_MS, RELAY_RESTART_MS, RELAY_RESTART_MS];
  }

  startAll() {
    if (!USE_UDP_RELAY) return;
    this.stopped = false;
    for (let q = 0; q < 4; q++) this.start(q);
    this.log(`4× RTSP→UDP relays on ports ${UDP_BASE_PORT}–${UDP_BASE_PORT + 3}${RELAY_TRANSCODE ? ` (transcode ${RELAY_TRANSCODE_FPS}fps ${RELAY_SCALE_W}×${RELAY_SCALE_H})` : ' (copy)'}`);
  }

  start(q) {
    if (!USE_UDP_RELAY) return;
    this._startWhenReady(q, 'start');
  }

  /** Planned reconnect after feeder publishes a new streamer to the RTSP path. */
  restart(q) {
    if (!USE_UDP_RELAY || q < 0 || q > 3) return;
    clearTimeout(this._nudgeTimer[q]);
    this._nudgeTimer[q] = setTimeout(() => {
      this._nudgeTimer[q] = null;
      this.log(`quad${q + 1} relay nudged (feeder swap)`);
      this._startWhenReady(q, 'swap');
    }, RELAY_NUDGE_DEBOUNCE_MS);
    this._nudgeTimer[q].unref?.();
  }

  async _startWhenReady(q, reason) {
    this._kill(q);
    const gen = this._gen[q];
    const url = quadUrl(q);
    const deadline = Date.now() + RELAY_RTSP_WAIT_MS;
    while (Date.now() < deadline) {
      if (this.stopped || gen !== this._gen[q]) return;
      if (await rtspHasVideo(url, 3000)) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    if (this.stopped || gen !== this._gen[q]) return;
    if (!(await rtspHasVideo(url, 3000))) {
      this.log(`quad${q + 1} relay: RTSP not ready after ${RELAY_RTSP_WAIT_MS / 1000}s (${reason}) — deferring`);
      setTimeout(() => {
        if (!this.stopped && gen === this._gen[q]) this._startWhenReady(q, `${reason}-retry`);
      }, RELAY_RESTART_MS * 3);
      return;
    }
    this._spawnRelay(q, gen);
  }

  _spawnRelay(q, gen) {
    this._exitBackoff[q] = RELAY_RESTART_MS;
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-rtsp_transport', 'tcp',
      '-fflags', '+genpts',
      '-i', quadUrl(q),
      ...relayOutputArgs(),
      '-f', 'mpegts', relayPublishUrl(q),
    ];
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.procs[q] = p;
    let errTail = '';
    p.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-500); });
    p.on('exit', (code) => {
      if (this.stopped || gen !== this._gen[q]) return;
      this.restarts[q]++;
      const swapRecovery = this.restarts[q] <= 3;
      const delay = swapRecovery
        ? RELAY_SWAP_RESTART_MS
        : Math.min(this._exitBackoff[q] * 2, RELAY_RESTART_MAX_MS);
      this._exitBackoff[q] = delay;
      this.log(`quad${q + 1} relay exited (${code}) — restart #${this.restarts[q]} in ${delay / 1000}s`);
      if (errTail.trim()) this.log(`relay stderr: ${errTail.trim().split('\n').slice(-1)[0]}`);
      setTimeout(() => {
        if (!this.stopped && gen === this._gen[q]) this._startWhenReady(q, 'exit');
      }, delay);
    });
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
    for (let q = 0; q < 4; q++) this._kill(q);
  }

  status() {
    return [0, 1, 2, 3].map(q => ({
      quadrant: q + 1,
      port: UDP_BASE_PORT + q,
      running: !!this.procs[q],
      restarts: this.restarts[q],
      listenUrl: relayListenUrl(q),
    }));
  }

  /** How many quadrant relays currently have a live ffmpeg process. */
  runningCount() {
    return this.procs.filter(Boolean).length;
  }

  /**
   * Block until at least minRunning relays are up (or timeout).
   * Prevents master ffmpeg from crash-looping on empty UDP ports at GO LIVE.
   */
  async waitForRunning({ minRunning = 4, timeoutMs = 45000 } = {}) {
    if (!USE_UDP_RELAY) return { ready: true, running: 0 };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const running = this.runningCount();
      if (running >= minRunning) return { ready: true, running };
      await new Promise(r => setTimeout(r, RELAY_WAIT_POLL_MS));
    }
    const running = this.runningCount();
    return { ready: running >= minRunning, running };
  }
}

module.exports = {
  QuadRelays,
  USE_UDP_RELAY,
  UDP_BASE_PORT,
  relayOutputArgs,
  relayPublishUrl,
  relayListenUrl,
  quadMasterInputArgs,
};
