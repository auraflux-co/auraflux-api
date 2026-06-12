/**
 * Live Grid — master compositor (CPD-944)
 *
 * Single long-running ffmpeg that reads the 4 stable MediaMTX quadrant paths
 * (rtsp://localhost:8554/quad1..4), composites a 2x2 1080p grid with
 * per-quadrant name overlays, and encodes via h264_videotoolbox to either a
 * local file (testing) or RTMP (YouTube Live).
 *
 * Name overlays use drawtext textfile=tmp/live_grid/quadN.txt:reload=1 —
 * the feeder layer rewrites those files on swap, so names update live with
 * no master restart.
 *
 * Audio v1: quadrant 1 only (highest-viewer streamer per the poller ranking).
 *
 * Swap behaviour: when a quadrant's publisher restarts, the master's RTSP
 * input EOFs; xstack (framesync) repeats the last frame, so the master keeps
 * running but that quadrant freezes. The supervisor treats any master exit OR
 * a quadrant swap as a cue to restart the master (~3-5s blip). YouTube keeps
 * the broadcast alive across short RTMP interruptions.
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const { quadUrl, nameFile } = require('./feeders');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const RESTART_DELAY_MS = 2_000;

function esc(p) {
  // ffmpeg filter option path escaping (':' and '\' are special)
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

/**
 * Build the master ffmpeg argument list.
 * @param {Object} opts
 *   output     — 'rtmp://...' or a local .mp4/.flv path
 *   durationSec— optional, for file test runs
 *   bitrateK   — video bitrate kbps (default 6000)
 *   logoPath   — optional PNG overlaid bottom-right
 */
function buildArgs(opts = {}) {
  const out = opts.output;
  if (!out) throw new Error('compositor: output required');
  const bitrateK = opts.bitrateK || 6000;
  const isRtmp = /^rtmps?:/.test(out);

  const args = ['-hide_banner', '-loglevel', 'warning'];
  for (let q = 0; q < 4; q++) {
    args.push('-rtsp_transport', 'tcp', '-i', quadUrl(q));
  }
  let logoIdx = -1;
  if (opts.logoPath) {
    logoIdx = 4;
    args.push('-i', opts.logoPath);
  }

  const cells = [];
  const fc = [];
  for (let q = 0; q < 4; q++) {
    const label = `q${q + 1}`;
    fc.push(
      `[${q}:v]scale=960:540:force_original_aspect_ratio=decrease,` +
      `pad=960:540:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,` +
      `drawtext=textfile='${esc(nameFile(q))}':reload=1:x=20:y=h-50:fontsize=30:` +
      `fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8[${label}]`
    );
    cells.push(`[${label}]`);
  }
  fc.push(`${cells.join('')}xstack=inputs=4:layout=0_0|960_0|0_540|960_540[grid]`);
  if (logoIdx >= 0) {
    fc.push(`[grid][${logoIdx}:v]overlay=W-w-24:H-h-24[v]`);
  } else {
    fc.push(`[grid]null[v]`);
  }

  args.push(
    '-filter_complex', fc.join(';'),
    '-map', '[v]', '-map', '0:a',
    '-c:v', 'h264_videotoolbox', '-b:v', `${bitrateK}k`, '-g', '60',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '44100'
  );
  if (opts.durationSec) args.push('-t', String(opts.durationSec));
  args.push('-f', isRtmp ? 'flv' : 'mp4', ...(isRtmp ? [] : ['-y']), out);
  return args;
}

class MasterCompositor extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.log = opts.log || ((m) => console.log(`[live-grid:master] ${m}`));
    this.proc = null;
    this.running = false;
    this.startedAt = null;
    this.restarts = 0;
    this._restartTimer = null;
  }

  start() {
    if (this.proc) return;
    this.running = true;
    this._spawn();
  }

  _spawn() {
    const args = buildArgs(this.opts);
    this.log(`starting master → ${this.opts.output}`);
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = p;
    this.startedAt = Date.now();

    let errTail = '';
    p.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-2000); });

    p.on('exit', (code) => {
      this.proc = null;
      this.emit('exit', { code, errTail });
      if (!this.running) return;
      this.restarts++;
      this.log(`master exited (${code}) — restart #${this.restarts} in ${RESTART_DELAY_MS / 1000}s`);
      if (errTail.trim()) this.log(`stderr tail: ${errTail.trim().split('\n').slice(-3).join(' | ')}`);
      this._restartTimer = setTimeout(() => this._spawn(), RESTART_DELAY_MS);
    });
  }

  /** Planned restart (e.g. after a quadrant swap left an input frozen). */
  restart() {
    if (!this.running) return;
    this.log('planned master restart (quadrant swap)');
    const p = this.proc;
    if (p) { try { p.kill('SIGKILL'); } catch (_) {} } // exit handler respawns
  }

  stop() {
    this.running = false;
    clearTimeout(this._restartTimer);
    if (this.proc) { try { this.proc.kill('SIGINT'); } catch (_) {} }
    this.proc = null;
  }

  status() {
    return {
      running: !!this.proc,
      output: this.opts.output,
      uptimeSec: this.startedAt && this.proc ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      restarts: this.restarts
    };
  }
}

module.exports = { MasterCompositor, buildArgs };
