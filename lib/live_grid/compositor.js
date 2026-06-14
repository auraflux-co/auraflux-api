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
 * Swap behaviour (CPD-1006): master reads fixed localhost UDP ports fed by
 * per-quadrant RTSP→UDP relays. Feeder swaps restart only the relay, not RTMP.
 * Set LIVE_GRID_UDP_RELAY=off to read RTSP directly (legacy).
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { quadMasterInputArgs, USE_UDP_RELAY } = require('./relays');
const { nameFile, BRAND } = require('./feeders');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const RESTART_DELAY_MS = 2_000;

function esc(p) {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

/** Encode settings from opts or LIVE_GRID_* env (CPD-1005). */
function gridEncodeConfig(opts = {}) {
  const fps = opts.fps || parseInt(process.env.LIVE_GRID_FPS || '60', 10);
  const audioBitrateK = opts.audioBitrateK || parseInt(process.env.LIVE_GRID_AUDIO_BITRATE_K || '192', 10);
  const bitrateK = opts.bitrateK || parseInt(process.env.LIVE_GRID_BITRATE_K || '6800', 10);
  const encoder = String(opts.encoder || process.env.LIVE_GRID_ENCODER || 'videotoolbox').toLowerCase();
  return { fps, audioBitrateK, bitrateK, encoder, gop: fps * 2 };
}

function videoEncoderArgs(cfg) {
  if (cfg.encoder === 'libx264') {
    return ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-b:v', `${cfg.bitrateK}k`, '-g', String(cfg.gop)];
  }
  return ['-c:v', 'h264_videotoolbox', '-profile:v', 'high', '-b:v', `${cfg.bitrateK}k`, '-g', String(cfg.gop)];
}

/** @deprecated use quadMasterInputArgs from relays.js */
function rtspInputArgs(q) {
  return quadMasterInputArgs(q);
}

/**
 * Build the master ffmpeg argument list.
 */
function buildArgs(opts = {}) {
  const out = opts.output;
  if (!out) throw new Error('compositor: output required');
  const cfg = gridEncodeConfig(opts);
  const isRtmp = /^rtmps?:/.test(out);
  const vertOut = opts.verticalOutput || null;
  const audioQuad = Number.isInteger(opts.audioQuad) ? Math.min(3, Math.max(0, opts.audioQuad)) : 0;

  const args = ['-hide_banner', '-loglevel', 'warning'];
  for (let q = 0; q < 4; q++) args.push(...rtspInputArgs(q));

  const logoPath = opts.logoPath !== undefined ? opts.logoPath
    : (fs.existsSync(BRAND.logo) ? BRAND.logo : null);
  let logoIdx = -1;
  if (logoPath) {
    logoIdx = 4;
    args.push('-i', logoPath);
  }

  let avatarIdx = -1;
  const avatarPath = opts.avatarOverlay;
  if (avatarPath && fs.existsSync(avatarPath)) {
    avatarIdx = logoIdx >= 0 ? 5 : 4;
    args.push('-re', '-stream_loop', '-1', '-i', avatarPath);
  }

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
      `pad=960:540:(ow-iw)/2:(oh-ih)/2:color=${BRAND.background},fps=${cfg.fps},setsar=1,` +
      `${nameTag(q)}[${label}]`
    );
    cells.push(`[${label}]`);
  }
  fc.push(`${cells.join('')}xstack=inputs=4:layout=0_0|960_0|0_540|960_540[stack]`);
  const ax = (audioQuad % 2) * 960;
  const ay = Math.floor(audioQuad / 2) * 540;
  fc.push(
    `[stack]drawbox=x=957:y=0:w=6:h=1080:color=${BRAND.accent}@1:t=fill,` +
    `drawbox=x=0:y=537:w=1920:h=6:color=${BRAND.accent}@1:t=fill,` +
    `drawbox=x=0:y=0:w=1920:h=1080:color=${BRAND.primary}@1:t=4,` +
    `drawbox@onair=x=${ax}:y=${ay}:w=960:h=540:color=${BRAND.accent}@1:t=5[grid]`
  );
  if (avatarIdx >= 0) {
    fc.push(
      `[${avatarIdx}:v]scale=280:-1,fps=${cfg.fps},format=yuva420p[av]`,
      `[grid][av]overlay=24:main_h-overlay_h-24:format=auto[gridav]`
    );
  }
  const gridOut = avatarIdx >= 0 ? '[gridav]' : '[grid]';
  for (let q = 0; q < 4; q++) {
    fc.push(`[${q}:a]aresample=async=1,volume@aq${q}=${!opts.muted && q === audioQuad ? 1 : 0}[aq${q}]`);
  }
  fc.push(`[aq0][aq1][aq2][aq3]amix=inputs=4:duration=longest:normalize=0[amx]`);
  fc.push(vertOut ? `[amx]asplit=2[aout][aoutv]` : `[amx]anull[aout]`);
  fc.push(`${gridOut}split=${vertOut ? 3 : 1}[g0]${vertOut ? '[gv1][gv2]' : ''}`);
  if (logoIdx >= 0) {
    fc.push(`[${logoIdx}:v]scale=110:-1[logo];[g0][logo]overlay=W-w-20:H-h-20[v]`);
  } else {
    fc.push(`[g0]null[v]`);
  }
  if (vertOut) {
    fc.push(
      `[gv1]crop@vcrop=960:540:${ax}:${ay},scale=1080:608[vc]`,
      `[gv2]scale=1080:608[vg]`,
      `[vc][vg]vstack=inputs=2,pad=1080:1920:0:(oh-ih)/2:color=${BRAND.background}[vert]`
    );
  }

  const aenc = ['-c:a', 'aac', '-b:a', `${cfg.audioBitrateK}k`, '-ac', '2', '-ar', '44100'];
  args.push('-filter_complex', fc.join(';'), '-map', '[v]', '-map', '[aout]', ...videoEncoderArgs(cfg), '-pix_fmt', 'yuv420p', ...aenc);
  if (opts.durationSec) args.push('-t', String(opts.durationSec));
  args.push('-f', isRtmp ? 'flv' : 'mp4', ...(isRtmp ? [] : ['-y']), out);
  if (vertOut) {
    const vertIsRtmp = /^rtmps?:/.test(vertOut);
    args.push('-map', '[vert]', '-map', '[aoutv]', ...videoEncoderArgs({ ...cfg, bitrateK: opts.verticalBitrateK || 4500 }), '-pix_fmt', 'yuv420p', ...aenc);
    if (opts.durationSec) args.push('-t', String(opts.durationSec));
    args.push('-f', vertIsRtmp ? 'flv' : 'mp4', vertOut);
  }
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

  setAudioQuad(q) {
    if (!Number.isInteger(q) || q < 0 || q > 3) return false;
    this.opts.audioQuad = q;
    return this._writeGates();
  }

  setMuted(muted) {
    this.opts.muted = !!muted;
    return this._writeGates();
  }

  _writeGates() {
    const p = this.proc;
    if (!p || !p.stdin.writable) return false;
    const q = Number.isInteger(this.opts.audioQuad) ? this.opts.audioQuad : 0;
    const muted = !!this.opts.muted;
    try {
      let cmds = '';
      for (let i = 0; i < 4; i++) cmds += `cvolume@aq${i} -1 volume ${!muted && i === q ? 1 : 0}\n`;
      cmds += `cdrawbox@onair -1 x ${(q % 2) * 960}\n`;
      cmds += `cdrawbox@onair -1 y ${Math.floor(q / 2) * 540}\n`;
      if (this.opts.verticalOutput) {
        cmds += `ccrop@vcrop -1 x ${(q % 2) * 960}\n`;
        cmds += `ccrop@vcrop -1 y ${Math.floor(q / 2) * 540}\n`;
      }
      p.stdin.write(cmds);
      return true;
    } catch (_) { return false; }
  }

  /** Fallback when RTSP reconnect fails after a feeder swap (CPD-1005). */
  restart() {
    if (!this.running) return;
    this.log('master restart (freeze fallback or unrecoverable error)');
    const p = this.proc;
    if (p) { try { p.kill('SIGKILL'); } catch (_) {} }
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
      restarts: this.restarts,
      encode: { ...gridEncodeConfig(this.opts), udpRelay: USE_UDP_RELAY },
    };
  }
}

module.exports = { MasterCompositor, buildArgs, gridEncodeConfig, quadMasterInputArgs, USE_UDP_RELAY };
