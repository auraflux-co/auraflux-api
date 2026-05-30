'use strict';
/**
 * lib/assembly_effects.js — CPD-431: FFmpeg Feature Filter Registry
 *
 * Every FFmpeg production effect is defined here as a named filter function.
 * Each function takes (jobSpec, inputLabel, outputLabel) and returns the FFmpeg
 * filter_complex fragment string to insert into the assembly pipeline.
 *
 * Design contract:
 *   - Each effect reads its configuration from jobSpec.addOns or jobSpec.effects
 *   - Each effect returns null if not requested or not configured
 *   - assembly.js calls applyEffectChain() which builds the composed filter_complex
 *   - Effects are applied in a defined order (see EFFECT_ORDER below)
 *   - All effects are gated by feature_gate.isFeatureEnabled() before running
 *
 * Adding a new effect:
 *   1. Add the feature key to lib/services/feature_gate.js (already done for all CPD-431 features)
 *   2. Add a function here in the correct category
 *   3. Add it to EFFECT_ORDER in the correct position
 *   4. Add a grader check in lib/services/job_grader.js (implemented:false until production-ready)
 *   5. Flip implemented:true in the grader when the feature ships
 *
 * Status legend:
 *   READY     — filter is implemented and tested, can be enabled in grader
 *   WIRED     — filter function defined, needs integration testing before grader flip
 *   STUB      — placeholder, filter string not yet complete
 */

const path = require('path');
const fs   = require('fs');

// ─── Effect order (applied sequentially in the filter_complex) ───────────────
// Order matters: colour comes before overlays, audio before final encode.
const EFFECT_ORDER = [
  // -- Video pre-processing --
  'delogo',        // remove source watermarks before anything else
  'chromakey',     // green screen removal (if source has green screen)
  'stabilize',     // stabilise before colour (stabilise on raw, grade after)
  // -- Layout / reframe --
  'portrait',      // 9:16 blur-pad reframe
  'square',        // 1:1 crop
  'letterbox',     // black bar padding
  'blur_pad',      // blurred background vertical fill
  // -- Temporal --
  'slow_motion',   // speed change
  'speed_ramp',    // speed ramp
  'reverse',       // reverse playback
  'freeze_frame',  // freeze last frame
  'ken_burns',     // slow zoom on static shots
  'loop',          // repeat clip
  // -- Colour --
  'lut',           // LUT colour grade
  'eq',            // brightness/contrast/saturation
  'curves',        // RGB curves
  'color_balance', // shadows/highlights balance
  'bw',            // black and white
  'vignette',      // vignette
  'film_grain',    // film grain
  'blur_effect',   // blur
  'sharpen',       // sharpen
  'denoise',       // video denoise
  'hdr_tonemapping',
  'fade',          // fade in/out
  'motion_blur',   // motion blur
  // -- Overlays --
  'intro_outro',   // intro/outro cards (handled at concat level, not filter)
  'progress_bar',  // playback progress bar
  'ticker',        // scrolling ticker
  'pip',           // picture-in-picture
  'animated_logo', // animated logo fade-in
  'fullscreen_image',
  'social_badge',  // @handle badge
  'qr_code',       // QR overlay
  'cta',           // subscribe/CTA animation
  'timer',         // on-screen timer
  // -- Captions --
  'captions_burnin',     // SRT burn-in
  'captions_whisper',    // Whisper word-level animated captions
  'captions_styled',     // ASS styled captions
  // -- Sprint 7 features --
  'lower_thirds',        // CPD-414: speaker name / topic label overlays
  'zoom_punch',          // CPD-415: zoom punch-in (stub)
  'animated_text_effects', // CPD-416: animated text effects (stub)
  // -- Visualisations --
  'waveform',      // audio waveform
  'spectrum',      // audio spectrum
];

// ─── Helper ──────────────────────────────────────────────────────────────────

function _esc(s) {
  // Escape text for FFmpeg drawtext — colons, apostrophes, backslashes
  if (!s) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:');
}

function _val(jobSpec, path, defaultVal) {
  const parts = path.split('.');
  let cur = jobSpec;
  for (const p of parts) {
    if (cur == null) return defaultVal;
    cur = cur[p];
  }
  return cur !== undefined && cur !== null ? cur : defaultVal;
}

// ─── Audio effects (applied via -af chain, separate from video filters) ───────
// These return af-chain fragments (not filter_complex entries).

const AUDIO_EFFECTS = {

  // READY — most impactful immediate win
  loudnorm(jobSpec) {
    if (_val(jobSpec, 'addOns.audio.loudnorm', false) !== true &&
        _val(jobSpec, 'effects.audio.loudnorm', false) !== true) return null;
    // Two-pass loudnorm is optimal but requires analysis pass; single-pass here
    return 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=none';
  },

  dynorm(jobSpec) {
    if (_val(jobSpec, 'effects.audio.dynorm', false) !== true) return null;
    return 'dynaudnorm=f=75:g=25';
  },

  compress(jobSpec) {
    if (_val(jobSpec, 'effects.audio.compress', false) !== true) return null;
    return 'acompressor=threshold=-20dB:ratio=3:attack=5:release=50';
  },

  limit(jobSpec) {
    if (_val(jobSpec, 'effects.audio.limit', false) !== true) return null;
    return 'alimiter=level_in=1:level_out=1:limit=0.8:attack=5:release=50';
  },

  denoise(jobSpec) {
    if (_val(jobSpec, 'effects.audio.denoise', false) !== true) return null;
    return 'afftdn=nr=10:nf=-25';
  },

  deess(jobSpec) {
    if (_val(jobSpec, 'effects.audio.deess', false) !== true) return null;
    return 'highshelf=f=8000:g=-5';
  },

  eq(jobSpec) {
    const cfg = _val(jobSpec, 'effects.audio.eq', null);
    if (!cfg) return null;
    // cfg: { frequency, width, gain } — e.g. boost presence at 3kHz
    const f = cfg.frequency || 3000;
    const w = cfg.width || 200;
    const g = cfg.gain || 3;
    return `equalizer=f=${f}:width_type=h:w=${w}:g=${g}`;
  },

  tone(jobSpec) {
    const cfg = _val(jobSpec, 'effects.audio.tone', null);
    if (!cfg) return null;
    const parts = [];
    if (cfg.bass != null) parts.push(`bass=g=${cfg.bass}:f=110`);
    if (cfg.treble != null) parts.push(`treble=g=${cfg.treble}`);
    return parts.join(',') || null;
  },

  mono(jobSpec) {
    if (_val(jobSpec, 'effects.audio.mono', false) !== true) return null;
    return 'pan=mono|c0=0.5*c0+0.5*c1';
  },

  reverb(jobSpec) {
    if (_val(jobSpec, 'effects.audio.reverb', false) !== true) return null;
    const depth = _val(jobSpec, 'effects.audio.reverbDepth', 0.4);
    return `aecho=0.8:0.88:60:${depth}`;
  },

  pitch(jobSpec) {
    const semitones = _val(jobSpec, 'effects.audio.pitchSemitones', null);
    if (semitones == null) return null;
    // Shift by N semitones: rate *= 2^(n/12), speed corrected by inverse atempo
    const ratio = Math.pow(2, semitones / 12);
    const baseRate = 44100;
    const newRate  = Math.round(baseRate * ratio);
    const tempo    = 1 / ratio;
    return `asetrate=${newRate},atempo=${tempo.toFixed(4)}`;
  },

  speed(jobSpec) {
    const s = _val(jobSpec, 'effects.audio.speed', null);
    if (!s || s === 1) return null;
    // atempo accepts 0.5-2.0; chain multiple for extreme values
    if (s >= 0.5 && s <= 2.0) return `atempo=${s}`;
    if (s > 2.0) return `atempo=2.0,atempo=${(s / 2).toFixed(4)}`;
    if (s < 0.5) return `atempo=0.5,atempo=${(s / 0.5).toFixed(4)}`;
    return null;
  },

  // CPD-417: Sound effects — SFX drops at highlight moments.
  // Full implementation requires an SFX library and per-segment timing data.
  // Stub: registered for feature gate + grader tracking; returns null (no-op).
  sound_effects(jobSpec) {
    const cfg = _val(jobSpec, 'addOns.sound_effects', null) ||
                _val(jobSpec, 'effects.audio.sound_effects', null);
    if (!cfg || !cfg.enabled) return null;
    // SFX mixing via amix with external audio files — deferred to CPD-417 sprint 7.
    return null;
  },
};

// ─── Video filter fragments ────────────────────────────────────────────────────
// Each returns a vf-fragment string or null. Fragments are composed by applyEffectChain().

const VIDEO_EFFECTS = {

  // ── Colour effects ────────────────────────────────────────────────────────

  lut(jobSpec) {
    const lutPath = _val(jobSpec, 'effects.color.lutPath', null) ||
                    _val(jobSpec, 'addOns.color.lutPath', null);
    if (!lutPath || !fs.existsSync(lutPath)) return null;
    return `lut3d='${_esc(lutPath)}'`;
  },

  eq(jobSpec) {
    const cfg = _val(jobSpec, 'effects.color.eq', null);
    if (!cfg) return null;
    const b  = cfg.brightness != null ? `:brightness=${cfg.brightness}` : '';
    const c  = cfg.contrast   != null ? `:contrast=${cfg.contrast}`     : '';
    const s  = cfg.saturation != null ? `:saturation=${cfg.saturation}` : '';
    const g  = cfg.gamma      != null ? `:gamma=${cfg.gamma}`           : '';
    return `eq${b}${c}${s}${g}` === 'eq' ? null : `eq${b}${c}${s}${g}`;
  },

  bw(jobSpec) {
    if (_val(jobSpec, 'addOns.color.bw', false) !== true &&
        _val(jobSpec, 'effects.color.bw', false) !== true) return null;
    return 'hue=s=0';
  },

  vignette(jobSpec) {
    if (_val(jobSpec, 'addOns.color.vignette', false) !== true &&
        _val(jobSpec, 'effects.color.vignette', false) !== true) return null;
    const angle = _val(jobSpec, 'effects.color.vignetteAngle', 'PI/4');
    return `vignette=angle=${angle}`;
  },

  film_grain(jobSpec) {
    if (_val(jobSpec, 'addOns.color.film_grain', false) !== true &&
        _val(jobSpec, 'effects.color.film_grain', false) !== true) return null;
    const strength = _val(jobSpec, 'effects.color.filmGrainStrength', 10);
    return `noise=alls=${strength}:allf=t`;
  },

  blur_effect(jobSpec) {
    const sigma = _val(jobSpec, 'effects.color.blurSigma', null);
    if (!sigma) return null;
    return `gblur=sigma=${sigma}`;
  },

  sharpen(jobSpec) {
    if (_val(jobSpec, 'effects.color.sharpen', false) !== true) return null;
    const lx = _val(jobSpec, 'effects.color.sharpenStrength', 5);
    return `unsharp=lx=${lx}:ly=${lx}:la=1.0`;
  },

  denoise(jobSpec) {
    if (_val(jobSpec, 'effects.color.denoise', false) !== true) return null;
    return 'hqdn3d=4:3:6:4.5';
  },

  hdr_tonemapping(jobSpec) {
    if (_val(jobSpec, 'effects.color.hdr_tonemapping', false) !== true) return null;
    return 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
  },

  fade(jobSpec) {
    const fadeIn  = _val(jobSpec, 'effects.video.fadeIn',  null);
    const fadeOut = _val(jobSpec, 'effects.video.fadeOut', null);
    const parts = [];
    if (fadeIn  != null) parts.push(`fade=t=in:st=0:d=${fadeIn}`);
    if (fadeOut != null) parts.push(`fade=t=out:st=${fadeOut.start}:d=${fadeOut.duration || 1}`);
    return parts.length ? parts.join(',') : null;
  },

  // ── Layout effects ────────────────────────────────────────────────────────

  portrait(jobSpec) {
    // 9:16 blur-pad: overlay 16:9 clip centred on blurred+scaled version of itself
    const platforms = _val(jobSpec, 'order.publish.platforms', []);
    const wants_portrait = _val(jobSpec, 'effects.layout.portrait', false) ||
      _val(jobSpec, 'addOns.layout.portrait', false) ||
      platforms.some((p) => ['tiktok', 'instagram_reels', 'youtube_shorts'].includes(p));
    if (!wants_portrait) return null;
    // This requires two inputs (same file twice); returned as filter_complex fragment
    // Caller must handle two-input case: [0:v] scaled to 1080:1920 blurred bg, [0:v] centred
    return '__PORTRAIT_BLUR_PAD__'; // sentinel — assembly.js handles this specially
  },

  square(jobSpec) {
    const platforms = _val(jobSpec, 'order.publish.platforms', []);
    const wants = _val(jobSpec, 'effects.layout.square', false) ||
      platforms.includes('instagram_feed');
    if (!wants) return null;
    return "crop='min(iw,ih)':'min(iw,ih)',scale=1080:1080";
  },

  letterbox(jobSpec) {
    const cfg = _val(jobSpec, 'effects.layout.letterbox', null);
    if (!cfg) return null;
    const w = cfg.width  || 1920;
    const h = cfg.height || 1080;
    return `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`;
  },

  // ── Temporal effects ──────────────────────────────────────────────────────

  slow_motion(jobSpec) {
    const factor = _val(jobSpec, 'effects.video.slowMotion', null);
    if (!factor || factor === 1) return null;
    return `setpts=${factor}*PTS`;
  },

  speed_ramp(jobSpec) {
    const factor = _val(jobSpec, 'effects.video.speedRamp', null);
    if (!factor || factor === 1) return null;
    return `setpts=${(1/factor).toFixed(4)}*PTS`;
  },

  ken_burns(jobSpec) {
    if (_val(jobSpec, 'effects.video.kenBurns', false) !== true &&
        _val(jobSpec, 'addOns.video.ken_burns', false) !== true) return null;
    const zoom  = _val(jobSpec, 'effects.video.kenBurnsZoom', 0.002);
    const dur   = _val(jobSpec, 'effects.video.kenBurnsDuration', 125);
    return `zoompan=z='zoom+${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${dur}:s=1920x1080`;
  },

  freeze_frame(jobSpec) {
    const holdSecs = _val(jobSpec, 'effects.video.freezeFrame', null);
    if (!holdSecs) return null;
    return `tpad=stop_mode=clone:stop_duration=${holdSecs}`;
  },

  flip_h(jobSpec) {
    if (_val(jobSpec, 'effects.video.flipH', false) !== true) return null;
    return 'hflip';
  },

  flip_v(jobSpec) {
    if (_val(jobSpec, 'effects.video.flipV', false) !== true) return null;
    return 'vflip';
  },

  rotate(jobSpec) {
    const deg = _val(jobSpec, 'effects.video.rotateDeg', null);
    if (deg == null) return null;
    const rad = (deg * Math.PI / 180).toFixed(4);
    return `rotate=${rad}`;
  },

  motion_blur(jobSpec) {
    if (_val(jobSpec, 'effects.video.motionBlur', false) !== true) return null;
    return 'tmix=frames=5:weights=1 1 1 1 1';
  },

  delogo(jobSpec) {
    const cfg = _val(jobSpec, 'effects.video.delogo', null);
    if (!cfg) return null;
    return `delogo=x=${cfg.x}:y=${cfg.y}:w=${cfg.w}:h=${cfg.h}`;
  },

  chromakey(jobSpec) {
    const cfg = _val(jobSpec, 'effects.video.chromakey', null);
    if (!cfg) return null;
    const color = cfg.color || '0x00FF00';
    const sim   = cfg.similarity || 0.1;
    const blend = cfg.blend || 0.0;
    return `chromakey=${color}:${sim}:${blend}`;
  },

  // ── Overlay effects (these need additional inputs) ─────────────────────────

  progress_bar(jobSpec) {
    if (_val(jobSpec, 'addOns.overlay.progress_bar', false) !== true &&
        _val(jobSpec, 'effects.overlay.progress_bar', false) !== true) return null;
    const h     = _val(jobSpec, 'effects.overlay.progressBarH', 8);
    const color = _val(jobSpec, 'effects.overlay.progressBarColor', 'white');
    const bg    = _val(jobSpec, 'effects.overlay.progressBarBg', 'black@0.5');
    // drawbox for background + foreground proportional to pts/duration
    return `drawbox=x=0:y=ih-${h}:w=iw:h=${h}:color=${bg}:t=fill,` +
           `drawbox=x=0:y=ih-${h}:w='iw*t/DURATION':h=${h}:color=${color}:t=fill`;
  },

  ticker(jobSpec) {
    const text = _val(jobSpec, 'effects.overlay.tickerText', null);
    if (!text) return null;
    const size  = _val(jobSpec, 'effects.overlay.tickerFontSize', 32);
    const color = _val(jobSpec, 'effects.overlay.tickerColor', 'white');
    const y     = _val(jobSpec, 'effects.overlay.tickerY', 'ih-50');
    const speed = _val(jobSpec, 'effects.overlay.tickerSpeed', 3);
    return `drawtext=text='${_esc(text)}':fontsize=${size}:fontcolor=${color}:y=${y}:x='w-mod(${speed}*n\\,w+tw)'`;
  },

  social_badge(jobSpec) {
    const handle = _val(jobSpec, 'effects.overlay.socialHandle', null) ||
                   _val(jobSpec, 'designSpec.chrome.streamer', null);
    if (!handle) return null;
    const text  = handle.startsWith('@') ? handle : `@${handle}`;
    const size  = _val(jobSpec, 'effects.overlay.badgeFontSize', 28);
    const color = _val(jobSpec, 'effects.overlay.badgeColor', 'white');
    const x     = _val(jobSpec, 'effects.overlay.badgeX', '20');
    const y     = _val(jobSpec, 'effects.overlay.badgeY', '20');
    return `drawtext=text='${_esc(text)}':fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}:shadowx=2:shadowy=2`;
  },

  timer(jobSpec) {
    if (_val(jobSpec, 'effects.overlay.timer', false) !== true) return null;
    const size  = _val(jobSpec, 'effects.overlay.timerFontSize', 36);
    const color = _val(jobSpec, 'effects.overlay.timerColor', 'white');
    const x     = _val(jobSpec, 'effects.overlay.timerX', '(w-tw)/2');
    const y     = _val(jobSpec, 'effects.overlay.timerY', '20');
    return `drawtext=text='%{pts\\:hms}':fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}:shadowx=2:shadowy=2`;
  },

  // ── Sprint 7 overlay features ─────────────────────────────────────────────

  // CPD-414: Lower thirds / name-plate overlays
  // Burns speaker name, topic label, or stat call-out in the lower third of the frame.
  // Config sources (first match wins):
  //   1. jobSpec.addOns.lower_thirds.items[] — explicit [{text,startSec,endSec,style}]
  //   2. Auto-generate from segmentDurations when addOns.lower_thirds.auto === true
  lower_thirds(jobSpec) {
    let items = _val(jobSpec, 'addOns.lower_thirds.items', null);

    if (!items || !items.length) {
      if (!_val(jobSpec, 'addOns.lower_thirds.auto', false) &&
          !_val(jobSpec, 'effects.overlay.lower_thirds', false)) return null;
      // Auto-generate one lower third per segment from segmentDurations labels
      const segs = _val(jobSpec, 'state.savedOutputs.segmentDurations', null);
      if (!segs || !segs.length) return null;
      let elapsed = 0;
      items = segs.map((s) => {
        const startSec = elapsed + 0.5; // 0.5s after cut to avoid freeze artifacts
        const endSec   = elapsed + Math.min(s.durationSeconds, startSec + 4) - 0.5;
        elapsed += s.durationSeconds || 0;
        return { text: s.label, startSec, endSec };
      });
    }

    if (!items || !items.length) return null;

    const style     = _val(jobSpec, 'addOns.lower_thirds.style', 'minimal');
    const fontSize  = style === 'bold' ? 44 : 36;
    const fontColor = _val(jobSpec, 'addOns.lower_thirds.fontColor', 'white');
    const bgColor   = _val(jobSpec, 'addOns.lower_thirds.bgColor', 'black@0.7');
    const yPos      = _val(jobSpec, 'addOns.lower_thirds.yPos', 'h-90');

    const filters = items
      .map((item) => {
        const text = _esc(item.text || '');
        if (!text) return null;
        const s = Number(item.startSec || 0).toFixed(2);
        const e = Number(item.endSec   || Number(s) + 4).toFixed(2);
        return (
          `drawtext=text='${text}':fontsize=${fontSize}:fontcolor=${fontColor}` +
          `:x=50:y=${yPos}:box=1:boxcolor=${bgColor}:boxborderw=8` +
          `:enable='between(t\\,${s}\\,${e})'`
        );
      })
      .filter(Boolean);

    return filters.length ? filters.join(',') : null;
  },

  // CPD-415: Zoom punch-in effect
  // Placeholder — full implementation deferred until per-clip zoom-point data is
  // wired from scene selection. Stubs the feature gate so it can be graded/tested.
  zoom_punch(jobSpec) {
    const cfg = _val(jobSpec, 'addOns.zoom_punch', null) ||
                _val(jobSpec, 'effects.video.zoom_punch', null);
    if (!cfg || !cfg.enabled) return null;
    // Full zoompan implementation requires per-clip x/y/scale data (CPD-415).
    return null;
  },

  // CPD-416: Animated text effects
  // Placeholder — full fly-in/fly-out text animation needs timing data per scene.
  animated_text_effects(jobSpec) {
    const cfg = _val(jobSpec, 'addOns.animated_text_effects', null) ||
                _val(jobSpec, 'effects.overlay.animated_text_effects', null);
    if (!cfg || !cfg.enabled) return null;
    // Full CSS-style drawtext animation (CPD-416) deferred.
    return null;
  },

  // ── Visualisations ────────────────────────────────────────────────────────

  waveform(jobSpec) {
    if (_val(jobSpec, 'effects.visual.waveform', false) !== true) return null;
    const h     = _val(jobSpec, 'effects.visual.waveformH', 80);
    const color = _val(jobSpec, 'effects.visual.waveformColor', '0xff6600');
    const y     = _val(jobSpec, 'effects.visual.waveformY', 'ih-80');
    return `[0:a]showwaves=mode=line:size=iw×${h}:colors=${color}[wv];[0:v][wv]overlay=0:${y}`;
  },
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build an audio filter chain string (-af argument) for the assembled video.
 * Returns null if no audio effects are active.
 *
 * @param {object} jobSpec
 * @returns {string|null}
 */
function buildAudioFilterChain(jobSpec) {
  const parts = [];
  for (const [name, fn] of Object.entries(AUDIO_EFFECTS)) {
    try {
      const frag = fn(jobSpec);
      if (frag) parts.push(frag);
    } catch (e) {
      console.warn(`[assembly_effects] audio.${name} threw: ${e.message}`);
    }
  }
  return parts.length ? parts.join(',') : null;
}

/**
 * Build a video filter chain string (-vf argument) for the assembled video.
 * Complex effects (portrait blur-pad, waveform) return sentinels and must be
 * handled by assembly.js with a full filter_complex.
 *
 * @param {object} jobSpec
 * @returns {string|null}
 */
function buildVideoFilterChain(jobSpec) {
  const parts = [];
  for (const effectName of EFFECT_ORDER) {
    const fn = VIDEO_EFFECTS[effectName];
    if (!fn) continue;
    try {
      const frag = fn(jobSpec);
      if (frag) parts.push(frag);
    } catch (e) {
      console.warn(`[assembly_effects] video.${effectName} threw: ${e.message}`);
    }
  }
  return parts.length ? parts.join(',') : null;
}

/**
 * Returns the list of active effect names for a given jobSpec.
 * Useful for GPT-4o QA prompt building and grader checks.
 *
 * @param {object} jobSpec
 * @returns {string[]}
 */
function getActiveEffects(jobSpec) {
  const active = [];
  for (const [name, fn] of Object.entries(AUDIO_EFFECTS)) {
    try { if (fn(jobSpec) != null) active.push(`audio.${name}`); } catch {}
  }
  for (const effectName of EFFECT_ORDER) {
    const fn = VIDEO_EFFECTS[effectName];
    if (!fn) continue;
    try { if (fn(jobSpec) != null) active.push(`video.${effectName}`); } catch {}
  }
  return active;
}

module.exports = {
  buildAudioFilterChain,
  buildVideoFilterChain,
  getActiveEffects,
  AUDIO_EFFECTS,
  VIDEO_EFFECTS,
  EFFECT_ORDER,
};
