'use strict';
/**
 * lib/assembly_postprocess.js — CPD-431: Post-processing effects pass
 *
 * Applies all ordered FFmpeg effects from assembly_effects.js to the
 * assembled video in a single final FFmpeg pass, before R2 upload.
 *
 * Integration point in assembly.js:
 *   Call applyPostProcessingEffects(jobSpec, outPath, log) BEFORE uploadToR2().
 *   It returns the path to write to R2 (may be a new temp file, or the same
 *   outPath if no effects were ordered).
 *
 * Effect categories handled here:
 *   - Audio filter chain (af): loudnorm, compress, duck, denoise, eq, etc.
 *   - Video filter chain (vf): lut, vignette, film_grain, bw, blur, sharpen, etc.
 *   - Layout transforms: 9:16 blur-pad portrait, 1:1 square crop
 *   - Encoding overrides: H.265, two-pass, embedded metadata
 *   - Post-processing flags written to jobSpec.state.savedOutputs for grader
 */

const path   = require('path');
const fs     = require('fs');
const { spawn } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');

const { buildAudioFilterChain, buildVideoFilterChain, getActiveEffects } = require('./assembly_effects');

const TMP_DIR = process.env.TMP_DIR || '/tmp';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _log(log, msg) {
  if (typeof log === 'function') log(msg);
  else console.log(msg);
}

function _val(obj, keyPath, def) {
  const parts = keyPath.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return def;
    cur = cur[p];
  }
  return cur !== undefined && cur !== null ? cur : def;
}

function _runFFmpeg(args, label) {
  return new Promise((res, rej) => {
    const ff = spawn(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('close', code => {
      if (code === 0) res();
      else rej(new Error(`[${label}] FFmpeg exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

function _tmpPath(base, suffix) {
  return path.join(TMP_DIR, `${path.basename(base, '.mp4')}_${suffix}_${Date.now()}.mp4`);
}

// ─── Loudness normalisation (two-pass EBU R128) ──────────────────────────────

async function _applyLoudnorm(inputPath, outputPath, log) {
  _log(log, `  [postprocess] EBU R128 loudness normalisation...`);

  // Pass 1: measure
  const measureArgs = [
    '-i', inputPath,
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
    '-f', 'null', '-',
  ];
  const measured = await new Promise((res, rej) => {
    const ff = spawn(ffmpegPath, measureArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('close', code => {
      // loudnorm outputs JSON to stderr
      const m = stderr.match(/\{[\s\S]*?"output_lra"[\s\S]*?\}/);
      if (m) { try { res(JSON.parse(m[0])); return; } catch {} }
      res(null); // fallback to single-pass if parse fails
    });
  });

  if (measured) {
    // Pass 2: apply with measured values for precise normalisation
    const { input_i, input_tp, input_lra, input_thresh, target_offset } = measured;
    const loudnormFilter = [
      'loudnorm=I=-16:TP=-1.5:LRA=11',
      `measured_I=${input_i}`,
      `measured_TP=${input_tp}`,
      `measured_LRA=${input_lra}`,
      `measured_thresh=${input_thresh}`,
      `offset=${target_offset}`,
      'linear=true',
    ].join(':');
    await _runFFmpeg([
      '-i', inputPath,
      '-af', loudnormFilter,
      '-c:v', 'copy',
      '-movflags', '+faststart', '-y', outputPath,
    ], 'loudnorm-pass2');
  } else {
    // Single-pass fallback
    await _runFFmpeg([
      '-i', inputPath,
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=none',
      '-c:v', 'copy',
      '-movflags', '+faststart', '-y', outputPath,
    ], 'loudnorm-single');
  }
  _log(log, `  [postprocess] Loudness normalisation complete`);
}

// ─── Portrait 9:16 blur-pad transform ────────────────────────────────────────

async function _applyPortraitBlurPad(inputPath, outputPath, log) {
  _log(log, `  [postprocess] 9:16 portrait blur-pad reframe...`);
  // Two-input filter_complex: blurred + scaled version as background, original centred
  // CPD-472: cap to 720x1280 (HD portrait) — 1080x1920 OOM-kills Render 512MB starter tier.
  // TikTok/Instagram accept 720p portrait; minimum is 540x960.
  const filter = [
    '[0:v]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,gblur=sigma=20[bg]',
    '[0:v]scale=720:-2:force_original_aspect_ratio=decrease[fg]',
    '[bg][fg]overlay=(W-w)/2:(H-h)/2[vout]',
  ].join(';');
  await _runFFmpeg([
    '-i', inputPath,
    '-filter_complex', filter,
    '-map', '[vout]', '-map', '0:a',
    '-c:v', 'libx264', '-crf', '20', '-preset', 'fast',
    '-c:a', 'copy',
    '-movflags', '+faststart', '-y', outputPath,
  ], 'portrait-blur-pad');
  _log(log, `  [postprocess] Portrait reframe complete`);
}

// ─── Square 1:1 crop ──────────────────────────────────────────────────────────

async function _applySquareCrop(inputPath, outputPath, log) {
  _log(log, `  [postprocess] 1:1 square crop (Instagram)...`);
  await _runFFmpeg([
    '-i', inputPath,
    '-vf', "crop='min(iw,ih)':'min(iw,ih)',scale=720:720",
    '-c:v', 'libx264', '-crf', '20', '-preset', 'fast',
    '-c:a', 'copy',
    '-movflags', '+faststart', '-y', outputPath,
  ], 'square-crop');
  _log(log, `  [postprocess] Square crop complete`);
}

// ─── Combined audio + video filter pass ───────────────────────────────────────

async function _applyFilterChains(inputPath, outputPath, vfChain, afChain, encodeOpts, log) {
  const args = ['-i', inputPath];

  if (vfChain) { args.push('-vf', vfChain); }
  if (afChain) { args.push('-af', afChain); }

  // Codec selection
  if (!vfChain) {
    args.push('-c:v', 'copy'); // video untouched — just remux
  } else if (encodeOpts.h265) {
    args.push('-c:v', 'libx265', '-crf', '24', '-preset', 'fast', '-tag:v', 'hvc1');
  } else {
    args.push('-c:v', 'libx264', '-crf', '20', '-preset', 'fast');
  }

  if (!afChain) {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', 'aac', '-b:a', '192k');
  }

  // Embedded metadata
  if (encodeOpts.title)       args.push('-metadata', `title=${encodeOpts.title}`);
  if (encodeOpts.description) args.push('-metadata', `comment=${encodeOpts.description}`);
  if (encodeOpts.artist)      args.push('-metadata', `artist=${encodeOpts.artist}`);

  args.push('-movflags', '+faststart', '-y', outputPath);
  await _runFFmpeg(args, 'filter-chains');
}

// ─── Encoding-only pass (metadata + codec only, no filters) ──────────────────

async function _applyEncodingOverrides(inputPath, outputPath, encodeOpts, log) {
  _log(log, `  [postprocess] Applying encoding overrides: ${JSON.stringify(encodeOpts)}`);
  const args = ['-i', inputPath];

  if (encodeOpts.h265) {
    args.push('-c:v', 'libx265', '-crf', '24', '-preset', 'fast', '-tag:v', 'hvc1');
    _log(log, `  [postprocess] H.265 encode (libx265)`);
  } else {
    args.push('-c:v', 'copy');
  }

  args.push('-c:a', 'copy');

  if (encodeOpts.title)       args.push('-metadata', `title=${encodeOpts.title}`);
  if (encodeOpts.description) args.push('-metadata', `comment=${encodeOpts.description}`);
  if (encodeOpts.artist)      args.push('-metadata', `artist=${encodeOpts.artist}`);

  args.push('-movflags', '+faststart', '-y', outputPath);
  await _runFFmpeg(args, 'encoding-overrides');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Apply all post-processing effects ordered by the job spec to the assembled video.
 * Returns the path to the processed file (may be the same inputPath if no effects active).
 * Never throws — logs warnings and returns inputPath on any failure to protect delivery.
 *
 * @param {object|null} jobSpec  — the full job spec (may be null for legacy callers)
 * @param {string}      inputPath — absolute path to assembled video
 * @param {function}    log      — log(msg) function from assembly context
 * @returns {Promise<string>}    — path to processed video for R2 upload
 */
async function applyPostProcessingEffects(jobSpec, inputPath, log) {
  if (!jobSpec || !inputPath || !fs.existsSync(inputPath)) {
    return inputPath;
  }

  const effects  = getActiveEffects(jobSpec);
  const platforms = _val(jobSpec, 'order.publish.platforms', []);
  // Skip portrait blur-pad if assembly_service already applied a vertical crop
  // (layoutPortraitApplied is set there). Prevents double-processing a 9:16 video.
  const _portraitAlreadyApplied = _val(jobSpec, 'state.savedOutputs.layoutPortraitApplied', false);
  const wantsPortrait = !_portraitAlreadyApplied && (
    _val(jobSpec, 'effects.layout.portrait', false) ||
    _val(jobSpec, 'addOns.layout.portrait', false) ||
    platforms.some(p => ['tiktok', 'instagram_reels', 'youtube_shorts'].includes(p))
  );
  const wantsSquare = _val(jobSpec, 'effects.layout.square', false) ||
    _val(jobSpec, 'addOns.layout.square', false) ||
    platforms.includes('instagram_feed');

  const wantsLoudnorm   = _val(jobSpec, 'addOns.audio.loudnorm', false) ||
                          _val(jobSpec, 'effects.audio.loudnorm', false);
  const wantsH265       = _val(jobSpec, 'effects.encode.h265', false);
  const wantsMetadata   = _val(jobSpec, 'effects.publish.metadata', false) ||
                          _val(jobSpec, 'addOns.publish.metadata', false);

  const encodeOpts = {
    h265:        wantsH265,
    title:       wantsMetadata ? (_val(jobSpec, 'order.title', '') || _val(jobSpec, 'jobTitle', '')) : null,
    description: wantsMetadata ? _val(jobSpec, 'order.description', '')  : null,
    artist:      wantsMetadata ? 'AuraFlux' : null,
  };

  const vfChain = buildVideoFilterChain(jobSpec);
  const afChain = buildAudioFilterChain(jobSpec);

  const hasFilters  = vfChain && !vfChain.includes('__PORTRAIT_BLUR_PAD__');
  const hasAudio    = !!afChain;
  const hasEncOpts  = wantsH265 || (wantsMetadata && encodeOpts.title);

  const nothingToDo = !wantsPortrait && !wantsSquare && !wantsLoudnorm && !hasFilters && !hasAudio && !hasEncOpts;
  if (nothingToDo) {
    return inputPath;
  }

  _log(log, `\n🎨 [postprocess] Applying ${effects.length} effects: ${effects.slice(0, 6).join(', ')}${effects.length > 6 ? ` +${effects.length - 6} more` : ''}`);

  let currentPath = inputPath;
  const tempPaths = [];

  try {
    // 1. Layout transform first (changes dimensions — must happen before filters)
    if (wantsPortrait) {
      const portraitOut = _tmpPath(inputPath, 'portrait');
      tempPaths.push(portraitOut);
      await _applyPortraitBlurPad(currentPath, portraitOut, log);
      currentPath = portraitOut;
    } else if (wantsSquare) {
      const squareOut = _tmpPath(inputPath, 'square');
      tempPaths.push(squareOut);
      await _applySquareCrop(currentPath, squareOut, log);
      currentPath = squareOut;
    }

    // 2. Video + audio filters in one pass
    if (hasFilters || hasAudio || hasEncOpts) {
      const filterOut = _tmpPath(inputPath, 'effects');
      tempPaths.push(filterOut);
      await _applyFilterChains(currentPath, filterOut, hasFilters ? vfChain : null, hasAudio ? afChain : null, encodeOpts, log);
      currentPath = filterOut;
    }

    // 3. Loudness normalisation (two-pass, must be last audio step)
    if (wantsLoudnorm && !hasAudio) {
      // Only run separate loudnorm pass if no other audio filter was applied
      // (loudnorm is included in afChain if audio.loudnorm is active)
      const loudOut = _tmpPath(inputPath, 'loud');
      tempPaths.push(loudOut);
      await _applyLoudnorm(currentPath, loudOut, log);
      currentPath = loudOut;
    }

    // Copy final result back to original outPath so upstream code is unaffected
    if (currentPath !== inputPath) {
      fs.copyFileSync(currentPath, inputPath);
      _log(log, `  [postprocess] Effects applied — output written back to ${path.basename(inputPath)}`);
    }

    // Write flags to jobSpec for grader
    if (!jobSpec.state) jobSpec.state = {};
    if (!jobSpec.state.savedOutputs) jobSpec.state.savedOutputs = {};
    if (wantsLoudnorm || hasAudio) jobSpec.state.savedOutputs.loudnormApplied = true;
    if (wantsPortrait)             jobSpec.state.savedOutputs.layoutPortraitApplied = true;
    if (wantsSquare)               jobSpec.state.savedOutputs.layoutSquareApplied = true;
    if (effects.length)            jobSpec.state.savedOutputs.postProcessEffects = effects;

    return inputPath;

  } catch (err) {
    _log(log, `  ⚠️  [postprocess] Effects pass failed (${err.message}) — continuing with unprocessed file`);
    return inputPath;
  } finally {
    // Clean up temp files
    for (const p of tempPaths) {
      try { if (p !== inputPath && fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    }
  }
}

module.exports = { applyPostProcessingEffects };
