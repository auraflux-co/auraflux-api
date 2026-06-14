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

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const USE_UDP_RELAY = String(process.env.LIVE_GRID_UDP_RELAY || 'on').toLowerCase() !== 'off';
const UDP_BASE_PORT = parseInt(process.env.LIVE_GRID_UDP_BASE_PORT || '5010', 10);
const RELAY_RESTART_MS = 1_000;

function relayPublishUrl(q) {
  return `udp://127.0.0.1:${UDP_BASE_PORT + q}?pkt_size=1316`;
}

function relayListenUrl(q) {
  return `udp://127.0.0.1:${UDP_BASE_PORT + q}?overrun_nonfatal=1&fifo_size=50000000`;
}

/** Master compositor input args for quadrant q. */
function quadMasterInputArgs(q) {
  if (USE_UDP_RELAY) {
    return ['-f', 'mpegts', '-i', relayListenUrl(q)];
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
  }

  startAll() {
    if (!USE_UDP_RELAY) return;
    this.stopped = false;
    for (let q = 0; q < 4; q++) this.start(q);
    this.log(`4× RTSP→UDP relays on ports ${UDP_BASE_PORT}–${UDP_BASE_PORT + 3}`);
  }

  start(q) {
    if (!USE_UDP_RELAY) return;
    this._kill(q);
    const gen = ++this._gen[q];
    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-rtsp_transport', 'tcp', '-i', quadUrl(q),
      '-c', 'copy', '-f', 'mpegts', relayPublishUrl(q),
    ];
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.procs[q] = p;
    let errTail = '';
    p.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-500); });
    p.on('exit', (code) => {
      if (this.stopped || gen !== this._gen[q]) return;
      this.restarts[q]++;
      this.log(`quad${q + 1} relay exited (${code}) — restart #${this.restarts[q]} in ${RELAY_RESTART_MS / 1000}s`);
      if (errTail.trim()) this.log(`relay stderr: ${errTail.trim().split('\n').slice(-1)[0]}`);
      setTimeout(() => {
        if (!this.stopped && gen === this._gen[q]) this.start(q);
      }, RELAY_RESTART_MS);
    });
  }

  /** Planned reconnect after feeder publishes a new streamer to the RTSP path. */
  restart(q) {
    if (!USE_UDP_RELAY || q < 0 || q > 3) return;
    this.log(`quad${q + 1} relay nudged (feeder swap)`);
    this.start(q);
  }

  _kill(q) {
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
}

module.exports = {
  QuadRelays,
  USE_UDP_RELAY,
  UDP_BASE_PORT,
  relayPublishUrl,
  relayListenUrl,
  quadMasterInputArgs,
};
