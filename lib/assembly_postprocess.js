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
// CPD-480: Central FFmpeg encoding presets and filter helpers.
const { buildFilterComplex, buildFilterChain } = require('./ffmpeg_builder');
const { recordTransformation, initManifest } = require('./services/processing_manifest');

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
    // CPD-479: -threads 2 caps per-job CPU so concurrent FFmpeg processes
    // don't fight for all cores on the 512 MB Render instance.
    const fullArgs = ['-threads', '2', ...args];
    const ff = spawn(ffmpegPath(), fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
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
  // Two-input filter_complex: blurred background + centred foreground.
  // CPD-472: cap to 720x1280 — 1080x1920 OOM-kills Render 512MB.
  // CPD-472 opt: blur the background at 360p then upscale — gblur at 720p is 4× the memory;
  //              blur is imperceptible at low res so quality is unchanged.
  const filter = [
    '[0:v]scale=360:640:force_original_aspect_ratio=increase,crop=360:640,gblur=sigma=20,scale=720:1280[bg]',
    '[0:v]scale=720:-2:force_original_aspect_ratio=decrease[fg]',
    '[bg][fg]overlay=(W-w)/2:(H-h)/2[vout]',
  ].join(';');
  await _runFFmpeg([
    '-i', inputPath,
    '-filter_complex', filter,
    '-map', '[vout]', '-map', '0:a',
    '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
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
    '-c:v', 'libx264', '-crf', '20', '-preset', 'fast', '-pix_fmt', 'yuv420p',
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
    args.push('-c:v', 'libx264', '-crf', '20', '-preset', 'fast', '-pix_fmt', 'yuv420p');
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
/**
 * CPD-507: Transcribe video audio via OpenAI Whisper and burn subtitles in.
 * Generates an SRT file then burns it using ffmpeg subtitles filter.
 * Non-blocking — returns inputPath unchanged on any error.
 */
async function _burnCaptionsWhisper(inputPath, log, jobSpec) {
  const captionsStyle = _val(jobSpec, 'captions.style', '') || _val(jobSpec, 'addOns.captions.style', '') || 'default';
  const OPENAI_KEY    = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) {
    if (log) log('[postprocess] captions: OPENAI_API_KEY not set — skipping');
    return inputPath;
  }

  const os    = require('os');
  const axios = require('axios');
  const { execFile: _ef } = require('child_process');
  const FormData = require('form-data');

  const srtPath    = inputPath.replace(/\.mp4$/, '_captions.srt');
  const captionOut = inputPath.replace(/\.mp4$/, '_captioned.mp4');

  try {
    // Extract audio for Whisper (16kHz mono mp3 is cheapest/fastest)
    const audioPath = inputPath.replace(/\.mp4$/, '_whisper_audio.mp3');
    await new Promise((res, rej) => _ef(
      require('./ffmpeg_utils').ffmpegPath(),
      ['-threads', '1', '-i', inputPath, '-vn', '-ar', '16000', '-ac', '1', '-b:a', '32k', '-y', audioPath],
      { timeout: 120000 },
      (err) => err ? rej(err) : res()
    ));

    // Call OpenAI Whisper transcription API
    const form = new FormData();
    form.append('file', fs.createReadStream(audioPath), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
    form.append('model', 'whisper-1');
    form.append('response_format', 'srt');
    const whisperResp = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      { headers: { ...form.getHeaders(), Authorization: `Bearer ${OPENAI_KEY}` }, timeout: 120000 }
    );
    try { fs.unlinkSync(audioPath); } catch (_) {}

    const srtContent = whisperResp.data;
    if (!srtContent || typeof srtContent !== 'string' || !srtContent.includes('-->')) {
      if (log) log('[postprocess] captions: Whisper returned empty SRT — skipping');
      return inputPath;
    }
    fs.writeFileSync(srtPath, srtContent, 'utf8');

    // Burn subtitle file into video using ffmpeg subtitles filter
    // force_style controls font size/colour based on captionsStyle
    const styleMap = {
      animated: 'FontName=Arial,FontSize=20,PrimaryColour=&H00FFFFFF,Bold=1,BorderStyle=3,OutlineColour=&H80000000',
      burnin:   'FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,Bold=0,BorderStyle=1,Outline=2',
      default:  'FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,Bold=1,BorderStyle=3,OutlineColour=&H80000000',
    };
    const forceStyle = styleMap[captionsStyle] || styleMap.default;
    // Escape path for FFmpeg filter syntax
    const escapedSrt = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');

    await new Promise((res, rej) => _ef(
      require('./ffmpeg_utils').ffmpegPath(),
      [
        '-threads', '2',
        '-i', inputPath,
        '-vf', `subtitles='${escapedSrt}':force_style='${forceStyle}'`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        '-y', captionOut,
      ],
      { timeout: 600000 },
      (err) => err ? rej(err) : res()
    ));

    try { fs.unlinkSync(srtPath); } catch (_) {}

    // Overwrite inputPath in-place so upstream code is unaffected
    fs.renameSync(captionOut, inputPath);
    if (log) log(`[postprocess] captions burned in (style=${captionsStyle}) via Whisper (CPD-507)`);
    return inputPath;

  } catch (captionErr) {
    if (log) log(`[postprocess] captions burn-in failed (non-fatal): ${captionErr.message?.slice(0, 120)}`);
    // Clean up any temp files
    try { if (fs.existsSync(srtPath))    fs.unlinkSync(srtPath);    } catch (_) {}
    try { if (fs.existsSync(captionOut)) fs.unlinkSync(captionOut); } catch (_) {}
    return inputPath;
  }
}

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
                          _val(jobSpec, 'effects.audio.loudnorm', false) ||
                          _val(jobSpec, 'audioOpts.loudnorm', false);
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
    // CPD-479: Portrait blur-pad reframe is deferred to the chrome overlay pass
    // (_applyChrome with needsPortraitReframe=true) so both happen in one FFmpeg decode.
    // Do NOT set layoutPortraitApplied here — that flag is set by developer_api.js
    // after chrome succeeds, so applyChrome knows the reframe hasn't run yet.
    if (wantsPortrait) {
      _log(log, '  [postprocess] Portrait reframe deferred to chrome overlay pass (CPD-479)');
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

    // CPD-507: Caption burn-in (Whisper transcription + SRT)
    // Runs AFTER filter pass so captions overlay the colour-graded / cropped video.
    const wantsCaptions = _val(jobSpec, 'captions.active', false) === true ||
      _val(jobSpec, 'addOns.captions.active', false) === true;
    if (wantsCaptions) {
      await _burnCaptionsWhisper(currentPath, log, jobSpec);
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
    // CPD-479: layoutPortraitApplied set by developer_api.js after chrome, not here.
    if (wantsSquare)               jobSpec.state.savedOutputs.layoutSquareApplied = true;
    if (effects.length)            jobSpec.state.savedOutputs.postProcessEffects = effects;

    // Write to processingManifest — one record per applied transformation group
    try {
      initManifest(jobSpec);
      if (wantsCaptions) {
        const captStyle = _val(jobSpec, 'captions.style', '') || _val(jobSpec, 'addOns.captions.style', '') || 'default';
        recordTransformation(jobSpec, { type: 'captions', params: { style: captStyle }, outputTimestamp: 'full_video' });
      }
      if (wantsLoudnorm || hasAudio) {
        recordTransformation(jobSpec, { type: 'audio.loudnorm', params: { loudnorm: wantsLoudnorm }, outputTimestamp: 'full_video' });
      }
      if (wantsSquare) {
        recordTransformation(jobSpec, { type: 'layout.square', params: {}, outputTimestamp: 'full_video' });
      }
      // Record each active video/audio effect individually
      for (const eff of effects) {
        if (eff.startsWith('audio.')) {
          recordTransformation(jobSpec, { type: eff, params: {}, outputTimestamp: 'full_video' });
        } else if (eff === 'video.lut' || eff === 'video.eq') {
          const preset = jobSpec.colorGrade?.preset || jobSpec.effects?.color?.preset || null;
          recordTransformation(jobSpec, { type: 'colorGrade', params: { effect: eff, preset }, outputTimestamp: 'full_video' });
        } else if (eff.startsWith('video.captions') || eff === 'video.captions_whisper' || eff === 'video.captions_burnin' || eff === 'video.captions_styled') {
          recordTransformation(jobSpec, { type: 'captions', params: { effect: eff }, outputTimestamp: 'full_video' });
        } else if (eff === 'video.ken_burns') {
          recordTransformation(jobSpec, { type: 'effects.zoom', params: {}, outputTimestamp: 'full_video' });
        } else if (eff === 'video.portrait') {
          // portrait applied by assembly_service (9:16 crop); record with matching ordered key
          recordTransformation(jobSpec, { type: 'layout.portrait', params: {}, outputTimestamp: 'full_video' });
        } else if (eff === 'video.square') {
          recordTransformation(jobSpec, { type: 'layout.square', params: {}, outputTimestamp: 'full_video' });
        } else if (eff.startsWith('video.')) {
          recordTransformation(jobSpec, { type: eff.replace('video.', 'effects.'), params: {}, outputTimestamp: 'full_video' });
        }
      }
    } catch (_manifestErr) {
      // Never let manifest writing break delivery
    }

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
