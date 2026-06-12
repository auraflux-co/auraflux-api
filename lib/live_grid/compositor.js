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
 * Audio (CPD-960): all four quadrants are mixed through per-quadrant volume
 * gates ([N:a]volume@aqN) into one amix; exactly one gate is open. Switching
 * audio writes runtime filter commands to ffmpeg's stdin (volume gates + the
 * gold on-air drawbox x/y) — NO master restart, no viewer-visible blip.
 *
 * Swap behaviour: when a quadrant's publisher restarts, the master's RTSP
 * input EOFs; xstack (framesync) repeats the last frame, so the master keeps
 * running but that quadrant freezes. The supervisor treats any master exit OR
 * a quadrant swap as a cue to restart the master (~3-5s blip). YouTube keeps
 * the broadcast alive across short RTMP interruptions.
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { quadUrl, nameFile, BRAND } = require('./feeders');

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
 *   audioQuad  — 0-3, which quadrant's audio goes to air (default 0)
 */
function buildArgs(opts = {}) {
  const out = opts.output;
  if (!out) throw new Error('compositor: output required');
  const bitrateK = opts.bitrateK || 6000;
  const isRtmp = /^rtmps?:/.test(out);
  const audioQuad = Number.isInteger(opts.audioQuad) ? Math.min(3, Math.max(0, opts.audioQuad)) : 0;

  const args = ['-hide_banner', '-loglevel', 'warning'];
  for (let q = 0; q < 4; q++) {
    args.push('-rtsp_transport', 'tcp', '-i', quadUrl(q));
  }
  const logoPath = opts.logoPath !== undefined ? opts.logoPath
    : (fs.existsSync(BRAND.logo) ? BRAND.logo : null);
  let logoIdx = -1;
  if (logoPath) {
    logoIdx = 4;
    args.push('-i', logoPath);
  }

  // ClipzWorld quadrant look: gold lower-third name tag, navy underfill
  const nameTag = (q) =>
    `drawtext=fontfile='${esc(BRAND.fontHead)}':textfile='${esc(nameFile(q))}':reload=1:` +
    `x=16:y=h-58:fontsize=34:fontcolor=${BRAND.background}:` +
    `box=1:boxcolor=${BRAND.accent}@0.95:boxborderw=10`;

  const cells = [];
  const fc = [];
  for (let q = 0; q < 4; q++) {
    const label = `q${q + 1}`;
    fc.push(
      `[${q}:v]scale=960:540:force_original_aspect_ratio=decrease,` +
      `pad=960:540:(ow-iw)/2:(oh-ih)/2:color=${BRAND.background},fps=30,setsar=1,` +
      `${nameTag(q)}[${label}]`
    );
    cells.push(`[${label}]`);
  }
  fc.push(`${cells.join('')}xstack=inputs=4:layout=0_0|960_0|0_540|960_540[stack]`);
  // Gold cross dividers + outer frame in brand navy/gold,
  // then a gold inner border marking the on-air (audible) quadrant.
  // drawbox@onair x/y are runtime-commandable — the border moves on audio
  // switches without a restart (CPD-960).
  const ax = (audioQuad % 2) * 960;
  const ay = Math.floor(audioQuad / 2) * 540;
  fc.push(
    `[stack]drawbox=x=957:y=0:w=6:h=1080:color=${BRAND.accent}@1:t=fill,` +
    `drawbox=x=0:y=537:w=1920:h=6:color=${BRAND.accent}@1:t=fill,` +
    `drawbox=x=0:y=0:w=1920:h=1080:color=${BRAND.primary}@1:t=4,` +
    `drawbox@onair=x=${ax}:y=${ay}:w=960:h=540:color=${BRAND.accent}@1:t=5[grid]`
  );
  // Audio: every quadrant feeds a named volume gate; exactly one is open.
  // amix normalize=0 so the single open gate passes at unity gain.
  for (let q = 0; q < 4; q++) {
    fc.push(`[${q}:a]volume@aq${q}=${q === audioQuad ? 1 : 0}[aq${q}]`);
  }
  fc.push(`[aq0][aq1][aq2][aq3]amix=inputs=4:duration=longest:normalize=0[aout]`);
  if (logoIdx >= 0) {
    fc.push(`[${logoIdx}:v]scale=110:-1[logo];[grid][logo]overlay=W-w-20:H-h-20[v]`);
  } else {
    fc.push(`[grid]null[v]`);
  }

  args.push(
    '-filter_complex', fc.join(';'),
    '-map', '[v]', '-map', '[aout]',
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
    // stdin stays open for runtime filter commands (seamless audio switch)
    const p = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    p.stdin.on('error', () => {});
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

  /**
   * Seamless on-air switch (CPD-960): flip the volume gates and move the gold
   * border via ffmpeg stdin commands — no restart. Returns false if the
   * process isn't up (caller may fall back to restart-with-new-args).
   */
  setAudioQuad(q) {
    if (!Number.isInteger(q) || q < 0 || q > 3) return false;
    this.opts.audioQuad = q; // future respawns start with the right gate open
    const p = this.proc;
    if (!p || !p.stdin.writable) return false;
    try {
      let cmds = '';
      for (let i = 0; i < 4; i++) cmds += `cvolume@aq${i} -1 volume ${i === q ? 1 : 0}\n`;
      cmds += `cdrawbox@onair -1 x ${(q % 2) * 960}\n`;
      cmds += `cdrawbox@onair -1 y ${Math.floor(q / 2) * 540}\n`;
      p.stdin.write(cmds);
      return true;
    } catch (_) { return false; }
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
