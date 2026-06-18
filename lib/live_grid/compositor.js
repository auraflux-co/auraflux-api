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
 * Audio (CPD-960): per-quadrant volume gates into amix; framed layout with
 * top brand bar, name strips under each cell, thick gold on-air border (brand_overlay.js).
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
const { BRAND } = require('./feeders');
const {
  gridFrameMetrics,
  buildCellFilter,
  xstackLayout,
  xstackFilter,
  buildFrameOverlayFilters,
  nameStripImageOverlays,
  compositorImageInputs,
  audioFrameZmqCommands,
  onAirVideoCropRect,
} = require('./brand_overlay');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const RESTART_DELAY_MS = 2_000;
const RESTART_BACKOFF_MAX_MS = 30_000;
const STABLE_RESET_MS = 120_000;

function audioDirectEnabled() {
  return String(process.env.LIVE_GRID_AUDIO_DIRECT || 'on').toLowerCase() !== 'off';
}

/** Pass through on-air AAC without aresample/re-encode (RTSP is clean; UDP remux was the gap source). */
function audioCopyEnabled() {
  return String(process.env.LIVE_GRID_AUDIO_COPY || 'on').toLowerCase() !== 'off';
}

/** True when audio quad can hop via stdin volume gates (no master restart). */
function audioHotSwitchEnabled(opts = {}) {
  const vertOut = opts.verticalOutput || null;
  const fallbackMusicPath = opts.fallbackMusicPath;
  const useDirectAudio = audioDirectEnabled() && !fallbackMusicPath;
  const useAudioCopy = useDirectAudio && audioCopyEnabled() && !vertOut;
  return !useAudioCopy;
}

function isUdpInputNotReady(errTail) {
  return /Operation not supported on socket|Error opening input file udp/i.test(errTail || '');
}

function esc(p) {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

/** Stable stereo AAC feed — avoids encoder -22 when UDP relays hand off. */
function finalizeAudioMix(label) {
  return `[${label}]aformat=sample_rates=44100:channel_layouts=stereo,` +
    'aresample=async=1:first_pts=0,apad=pad_dur=1[aout]';
}

/** Encode settings from opts or LIVE_GRID_* env (CPD-1005). */
function gridEncodeConfig(opts = {}) {
  const fps = opts.fps || parseInt(process.env.LIVE_GRID_FPS || '60', 10);
  const audioBitrateK = opts.audioBitrateK || parseInt(process.env.LIVE_GRID_AUDIO_BITRATE_K || '192', 10);
  const bitrateK = opts.bitrateK || parseInt(process.env.LIVE_GRID_BITRATE_K || '9000', 10);
  const encoder = String(opts.encoder || process.env.LIVE_GRID_ENCODER || 'videotoolbox').toLowerCase();
  return { fps, audioBitrateK, bitrateK, encoder, gop: fps * 2 };
}

/** Output + per-quadrant cell size (LIVE_GRID_OUTPUT_W/H default 1920×1080). */
function gridLayoutDims() {
  const outW = parseInt(process.env.LIVE_GRID_OUTPUT_W || '1920', 10);
  const outH = parseInt(process.env.LIVE_GRID_OUTPUT_H || '1080', 10);
  const cellW = Math.floor(outW / 2);
  const cellH = Math.floor(outH / 2);
  return { outW, outH, cellW, cellH };
}

function outputDar(outW, outH) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(outW, outH);
  return `${outW / g}/${outH / g}`;
}

/** Letterbox 16:9 grid into 1080×1080 — opt-in only; default off (prior grid VODs are native 1920×1080). */
function youtubeSquarePadEnabled() {
  return String(process.env.LIVE_GRID_YOUTUBE_SQUARE_PAD ?? 'off').toLowerCase() === 'on';
}

/** Per-quadrant scale — letterbox (decrease+pad) matches pre-Jun-16 VODs; cover crops to fill cell. */
function gridCellVideoFilter(cellW, cellH) {
  const fit = String(process.env.LIVE_GRID_CELL_FIT || 'letterbox').toLowerCase();
  if (fit === 'contain' || fit === 'letterbox') {
    return `scale=${cellW}:${cellH}:flags=fast_bilinear:force_original_aspect_ratio=decrease,` +
      `pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:color=${BRAND.background},`;
  }
  return `scale=${cellW}:${cellH}:flags=fast_bilinear:force_original_aspect_ratio=increase,crop=${cellW}:${cellH},`;
}

function videoEncoderArgs(cfg, { isRtmp = false } = {}) {
  if (cfg.encoder === 'libx264') {
    const x264 = `keyint=${cfg.gop}:min-keyint=${cfg.gop}:scenecut=0`;
    return [
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
      '-profile:v', 'high', '-level', '4.1',
      '-b:v', `${cfg.bitrateK}k`, '-g', String(cfg.gop),
      '-x264-params', x264,
    ];
  }
  return ['-c:v', 'h264_videotoolbox', '-profile:v', 'high', '-b:v', `${cfg.bitrateK}k`, '-g', String(cfg.gop)];
}

/** YouTube RTMP reads FLV + H264 VUI — stamp SAR 1:1 and explicit frame size for landscape VOD. */
function rtmpVideoOut(cfg, outW, outH) {
  const dar = outputDar(outW, outH).replace('/', ':');
  return [
    ...videoEncoderArgs(cfg, { isRtmp: true }),
    '-pix_fmt', 'yuv420p',
    '-bsf:v', 'h264_metadata=sample_aspect_ratio=1/1',
    '-s', `${outW}x${outH}`,
    '-aspect', dar,
  ];
}

/** Summarize what the master encoder will send to YouTube RTMP (for startup guards + logs). */
function describeEncodePlan(opts = {}) {
  const { outW, outH } = gridLayoutDims();
  const localHls = opts.localHlsPath || null;
  const isRtmp = !!(opts.output && /^rtmps?:/.test(opts.output));
  const sqPad = youtubeSquarePadEnabled() && localHls && isRtmp && outW > outH;
  return {
    canvas: `${outW}×${outH}`,
    localHls: localHls ? `${outW}×${outH}` : null,
    rtmp: sqPad ? '1080×1080 (square letterbox — wrong for landscape grid VODs)' : `${outW}×${outH} landscape`,
    rtmpSquare: sqPad,
    squarePad: youtubeSquarePadEnabled(),
    cellFit: String(process.env.LIVE_GRID_CELL_FIT || 'letterbox'),
    encoder: gridEncodeConfig(opts).encoder,
  };
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
  const { outW, outH } = gridLayoutDims();
  const frame = gridFrameMetrics(outW, outH);
  const { cellW, cellVideoH } = frame;
  const dar = outputDar(outW, outH);
  const aspectLabel = dar.replace('/', ':');
  const localHls = opts.localHlsPath || null;
  const isHlsOut = !isRtmp && String(out).endsWith('.m3u8');
  const sqPad = youtubeSquarePadEnabled() && localHls && isRtmp && outW > outH;
  const args = ['-hide_banner', '-loglevel', 'warning'];
  for (let q = 0; q < 4; q++) args.push(...rtspInputArgs(q));

  const logoPath = opts.logoPath && fs.existsSync(opts.logoPath) ? opts.logoPath : null;
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

  let bedIdx = -1;
  const fallbackMusicPath = opts.fallbackMusicPath;
  if (fallbackMusicPath && fs.existsSync(fallbackMusicPath)) {
    bedIdx = Math.max(logoIdx, avatarIdx) + 1;
    if (bedIdx < 4) bedIdx = 4;
    args.push('-re', '-stream_loop', '-1', '-i', fallbackMusicPath);
  }

  let imgBase = Math.max(logoIdx, avatarIdx, bedIdx) + 1;
  if (imgBase < 4) imgBase = 4;
  const imageInputs = compositorImageInputs();
  for (const img of imageInputs) {
    if (!fs.existsSync(img.path)) continue;
    args.push('-loop', '1', '-i', img.path);
  }
  const avatarInputIdx = imgBase;
  const badgeInputIdx = imgBase + 4;

  const frameOpts = { muted: !!opts.muted, fallbackMusicActive: !!opts.fallbackMusicActive };
  const cells = [];
  const fc = [];
  for (let q = 0; q < 4; q++) {
    fc.push(buildCellFilter(q, frame, esc, cfg.fps));
    cells.push(`[q${q + 1}]`);
  }
  fc.push(xstackFilter(cells, frame) + '[stack]');
  fc.push(`[stack]${buildFrameOverlayFilters(frame, audioQuad, frameOpts, esc)}[grid]`);
  if (fs.existsSync(imageInputs[4]?.path || '')) {
    fc.push(nameStripImageOverlays(frame, audioQuad, frameOpts, esc, {
      avatar: avatarInputIdx,
      badge: badgeInputIdx,
    }));
  }
  if (avatarIdx >= 0) {
    fc.push(
      `[${avatarIdx}:v]scale=280:-1,fps=${cfg.fps},format=yuva420p[av]`,
      `[gridout][av]overlay=24:main_h-overlay_h-24:format=auto[gridav]`
    );
  }
  const gridOut = avatarIdx >= 0 ? '[gridav]' : (fs.existsSync(imageInputs[4]?.path || '') ? '[gridout]' : '[grid]');
  const useDirectAudio = audioDirectEnabled() && !fallbackMusicPath;
  const useAudioCopy = useDirectAudio && audioCopyEnabled() && !vertOut;
  const useAmixGates = audioHotSwitchEnabled(opts);
  if (useAmixGates && !fallbackMusicPath) {
    for (let q = 0; q < 4; q++) {
      fc.push(
        `[${q}:a]aresample=44100:async=1:first_pts=0,` +
        `aformat=sample_rates=44100:channel_layouts=stereo,` +
        `volume@aq${q}=${!opts.muted && q === audioQuad ? 1 : 0}[aq${q}]`
      );
    }
    fc.push(`[aq0][aq1][aq2][aq3]amix=inputs=4:duration=longest:dropout_transition=2:normalize=0[amxraw]`);
    fc.push(`anullsrc=r=44100:cl=stereo[sil]`);
    fc.push(`[amxraw][sil]amix=inputs=2:duration=longest:weights=1 0.001[amx]`);
  } else if (audioDirectEnabled() && fallbackMusicPath) {
    fc.push(`[${audioQuad}:a]aresample=44100:async=0:first_pts=0,anull[axon]`);
  }
  if (bedIdx >= 0) {
    const bedVol = opts.fallbackMusicActive ? (opts.fallbackMusicVolume ?? 0.32) : 0;
    fc.push(`[${bedIdx}:a]aresample=44100:async=0,volume@bed=${bedVol}[beda]`);
    const mixIn = useAmixGates && !fallbackMusicPath ? '[amx]' : (audioDirectEnabled() ? '[axon]' : '[amx]');
    fc.push(`${mixIn}[beda]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[amix]`);
    if (vertOut) fc.push(`[amix]asplit=2[aout][aoutv]`);
    else if (sqPad) fc.push(`[amix]asplit=2[aout_hls][aout_yt]`);
    else fc.push(finalizeAudioMix('amix'));
  } else if (useAmixGates && !fallbackMusicPath) {
    if (vertOut) fc.push(`[amx]asplit=2[aout][aoutv]`);
    else if (sqPad) fc.push(`[amx]asplit=2[aout_hls][aout_yt]`);
    else fc.push(finalizeAudioMix('amx'));
  }
  fc.push(`${gridOut}split=${vertOut ? 3 : 1}[g0]${vertOut ? '[gv1][gv2]' : ''}`);
  if (logoIdx >= 0) {
    fc.push(`[${logoIdx}:v]scale=110:-1[logo];[g0]setsar=1,setdar=${dar}[gbase];[gbase][logo]overlay=W-w-20:H-h-20,setsar=1,setdar=${dar}[vland]`);
  } else {
    fc.push(`[g0]setsar=1,setdar=${dar}[vland]`);
  }
  if (sqPad) {
    fc.push(
      `[vland]split=2[v_hls][v_rtmp_in]`,
      `[v_rtmp_in]scale=1080:-2:flags=fast_bilinear,` +
      `pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=${BRAND.background},setsar=1,setdar=1/1[v_yt]`
    );
  }
  if (vertOut) {
    const crop = onAirVideoCropRect(audioQuad, frame);
    fc.push(
      `[gv1]crop@vcrop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=1080:608[vc]`,
      `[gv2]scale=1080:608[vg]`,
      `[vc][vg]vstack=inputs=2,pad=1080:1920:0:(oh-ih)/2:color=${BRAND.background}[vert]`
    );
  }

  const aenc = useAudioCopy
    ? ['-c:a', 'copy']
    : ['-c:a', 'aac', '-b:a', `${cfg.audioBitrateK}k`, '-ac', '2', '-ar', '44100'];
  const audioMapHls = useAudioCopy
    ? ['-map', `${audioQuad}:a`]
    : ['-map', sqPad ? '[aout_hls]' : '[aout]'];
  const audioMapYt = useAudioCopy
    ? ['-map', `${audioQuad}:a`]
    : ['-map', sqPad ? '[aout_yt]' : '[aout]'];
  const audioMap = audioMapHls;
  const landscapeEnc = [
    ...videoEncoderArgs(cfg),
    '-pix_fmt', 'yuv420p',
    ...(cfg.encoder !== 'libx264' && (localHls || isHlsOut)
      ? ['-bsf:v', 'h264_metadata=sample_aspect_ratio=1/1']
      : []),
  ];
  const rtmpEnc = rtmpVideoOut(cfg, outW, outH);

  args.push('-filter_complex', fc.join(';'));

  if (sqPad) {
    fs.mkdirSync(path.dirname(localHls), { recursive: true });
    args.push(
      '-map', '[v_hls]', ...audioMapHls, ...landscapeEnc, ...aenc,
      '-f', 'hls', '-hls_time', '2', '-hls_list_size', '12',
      '-hls_flags', 'delete_segments+append_list+omit_endlist',
      localHls,
      '-map', '[v_yt]', ...audioMapYt, ...rtmpEnc, ...aenc,
    );
    if (useAudioCopy) args.push('-bsf:a', 'aac_adtstoasc');
    args.push('-f', 'flv', out);
  } else {
    const videoOut = isRtmp
      ? rtmpEnc
      : [...landscapeEnc, '-aspect', aspectLabel, '-s', `${outW}x${outH}`];
    args.push('-map', '[vland]', ...audioMap, ...videoOut, ...aenc);
    if (useAudioCopy && (isRtmp || localHls)) args.push('-bsf:a', 'aac_adtstoasc');
    if (localHls && isRtmp) {
      fs.mkdirSync(path.dirname(localHls), { recursive: true });
      const tee = `[f=flv:flvflags=no_duration_filesize:onfail=ignore]${out}|[f=hls:hls_time=2:hls_list_size=12:hls_flags=delete_segments+append_list+omit_endlist:onfail=ignore]${localHls}`;
      args.push('-f', 'tee', tee);
    } else if (isRtmp) {
      args.push('-f', 'flv', out);
    } else if (isHlsOut) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      args.push(
        '-f', 'hls',
        '-hls_time', '2',
        '-hls_list_size', '12',
        '-hls_flags', 'delete_segments+append_list+omit_endlist',
        out
      );
    } else {
      args.push('-f', 'mp4', '-y', out);
    }
  }

  if (opts.durationSec) args.push('-t', String(opts.durationSec));
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
    this._stableTimer = null;
    this._backoffMs = RESTART_DELAY_MS;
  }

  _clearStableTimer() {
    if (this._stableTimer) clearTimeout(this._stableTimer);
    this._stableTimer = null;
  }

  _scheduleStableReset() {
    this._clearStableTimer();
    this._stableTimer = setTimeout(() => {
      if (!this.proc) return;
      if (this.restarts > 0) this.log('encoder stable — restart counter reset');
      this.restarts = 0;
      this._backoffMs = RESTART_DELAY_MS;
    }, STABLE_RESET_MS);
    this._stableTimer.unref?.();
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
      this._clearStableTimer();
      this.emit('exit', { code, errTail });
      if (!this.running) return;
      this.restarts++;
      const udpWait = isUdpInputNotReady(errTail);
      const delay = udpWait
        ? Math.min(this._backoffMs * 2, RESTART_BACKOFF_MAX_MS)
        : RESTART_DELAY_MS;
      if (udpWait) this._backoffMs = delay;
      else this._backoffMs = RESTART_DELAY_MS;
      this.log(`master exited (${code}) — restart #${this.restarts} in ${delay / 1000}s`);
      if (errTail.trim()) this.log(`stderr tail: ${errTail.trim().split('\n').slice(-3).join(' | ')}`);
      if (udpWait) this.log('UDP inputs not ready — waiting for quadrant relays');
      this._restartTimer = setTimeout(() => this._spawn(), delay);
    });

    this._scheduleStableReset();
  }

  setAudioQuad(q) {
    if (!Number.isInteger(q) || q < 0 || q > 3) return false;
    const prev = this.opts.audioQuad;
    this.opts.audioQuad = q;
    const copyMode = audioDirectEnabled() && audioCopyEnabled() && !this.opts.verticalOutput && !this.opts.fallbackMusicPath;
    if (copyMode && q !== prev) return false;
    return this._writeGates();
  }

  setMuted(muted) {
    this.opts.muted = !!muted;
    if (!muted) this.opts.fallbackMusicActive = false;
    return this._writeGates();
  }

  setFallbackMusic(active, { volume } = {}) {
    if (!this.opts.fallbackMusicPath) return false;
    this.opts.fallbackMusicActive = !!active;
    if (volume != null) this.opts.fallbackMusicVolume = volume;
    if (active) {
      this.opts.muted = true;
    } else {
      // Bed off → restore the on-air Twitch quadrant (was left muted when bed turned on).
      this.opts.muted = false;
    }
    return this._writeGates();
  }

  _writeGates() {
    const p = this.proc;
    if (!p || !p.stdin.writable) return false;
    const q = Number.isInteger(this.opts.audioQuad) ? this.opts.audioQuad : 0;
    const muted = !!this.opts.muted;
    const bedActive = !!this.opts.fallbackMusicActive && !!this.opts.fallbackMusicPath;
    const frame = gridFrameMetrics();
    try {
      let cmds = '';
      if (audioHotSwitchEnabled(this.opts)) {
        for (let i = 0; i < 4; i++) {
          cmds += `cvolume@aq${i} -1 volume ${!muted && i === q ? 1 : 0}\n`;
        }
      }
      if (this.opts.fallbackMusicPath) {
        const bedVol = bedActive ? (this.opts.fallbackMusicVolume ?? 0.32) : 0;
        cmds += `cvolume@bed -1 volume ${bedVol}\n`;
      }
      cmds += audioFrameZmqCommands(q, frame, { muted, fallbackMusicActive: bedActive });
      if (this.opts.verticalOutput) {
        const crop = onAirVideoCropRect(q, frame);
        cmds += `ccrop@vcrop -1 x ${crop.x}\n`;
        cmds += `ccrop@vcrop -1 y ${crop.y}\n`;
        cmds += `ccrop@vcrop -1 w ${crop.w}\n`;
        cmds += `ccrop@vcrop -1 h ${crop.h}\n`;
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
    this._clearStableTimer();
    if (this.proc) { try { this.proc.kill('SIGKILL'); } catch (_) {} }
    this.proc = null;
  }

  status() {
    return {
      running: !!this.proc,
      output: this.opts.output,
      uptimeSec: this.startedAt && this.proc ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      restarts: this.restarts,
      encode: { ...gridEncodeConfig(this.opts), udpRelay: USE_UDP_RELAY, audioHotSwitch: audioHotSwitchEnabled(this.opts) },
    };
  }
}

module.exports = { MasterCompositor, buildArgs, gridEncodeConfig, gridLayoutDims, describeEncodePlan, quadMasterInputArgs, USE_UDP_RELAY, isUdpInputNotReady, audioDirectEnabled, audioCopyEnabled, audioHotSwitchEnabled, youtubeSquarePadEnabled };
