'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');
const { downloadMediaToFile, needsYtdlpDownload } = require('./content_library/media_download');
const { mergeCompCreative } = require('./clip_comp_creative');
const {
  applyPortraitLayout,
  applyPortraitLayoutTimed,
  buildClipCompLogoFilter,
  resolveLayoutMode,
  resolveEffectiveLayoutMode,
  resolveSplitTopHeight,
  resolveFullBleedSubject,
  resolveFullBleedSourceRect,
  probeVideoDimensions,
} = require('./clip_comp_layout');

const PREVIEW_DIR = path.join(__dirname, '../tmp/composition_preview');
const LOGO_PATH = path.join(__dirname, '../assets/cwn_logo.png');
const MAX_PREVIEW_SEC = 6;
/** Timed layout preview — long enough to show split→full transition. */
const MAX_TIMED_PREVIEW_SEC = 20;
/** Full trim-window review in Compose (CPD-1234) — not the 6s layout preview loop. */
const MAX_SOURCE_REVIEW_SEC = 180;
/** Full trim-window assembled preview in Compose timeline editor (CPD-1243). */
const MAX_TIMELINE_PREVIEW_SEC = 180;

/** One timeline preview at a time — parallel encodes were wedging the UI. */
let _timelinePreviewChain = Promise.resolve();

function runTimelinePreviewExclusive(fn) {
  const run = _timelinePreviewChain.then(() => fn());
  _timelinePreviewChain = run.catch(() => {});
  return run;
}

async function downscalePreviewSource(inputPath, outputPath, log) {
  // CPD-1289 — keep more detail so Punch/C9 grade is visible (was 960/crf26 mush)
  await execFileAsync(ffmpegPath(), [
    '-y', '-i', inputPath,
    '-vf', 'scale=1280:-2,fps=30',
    '-c:v', 'libx264', '-crf', '22', '-preset', 'veryfast',
    '-c:a', 'copy', '-movflags', '+faststart',
    outputPath,
  ], { timeout: 120000 });
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 500) {
    throw new Error('Preview downscale failed');
  }
  log('[composition-preview] downscaled to 1280w @ 30fps for preview');
  return outputPath;
}

/** CPD-1289 — burn CapCut look tint into preview so C9 Punch is visible before EXECUTE. */
async function applyLookTintPreview(inputPath, outputPath, compCreative, log) {
  const lookName = compCreative?.look?.preset;
  if (!lookName || lookName === 'auto') return inputPath;
  const { resolveLookPreset, buildColorbalanceFrag } = require('./look_presets');
  const frag = buildColorbalanceFrag(resolveLookPreset(lookName).colorbalance);
  if (!frag) return inputPath;
  await execFileAsync(ffmpegPath(), [
    '-y', '-i', inputPath,
    '-vf', `${frag},format=yuv420p`,
    '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast',
    '-c:a', 'copy', '-movflags', '+faststart',
    outputPath,
  ], { timeout: 120000 });
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 500) {
    log(`[composition-preview] look tint skipped (encode failed) — ${lookName}`);
    return inputPath;
  }
  log(`[composition-preview] look tint applied: ${lookName}`);
  return outputPath;
}

/**
 * CPD-1291 — Near-final Review stack (same burns as assembly, minus Whisper).
 * Order matches clip_comp_assembly: camera FX → speed → transform → bed/SFX.
 */
async function applyNearFinalPreviewStack(inputPath, tmpDir, {
  clip = null,
  compCreative = null,
  previewDur = 30,
  log = console.log,
} = {}) {
  const applied = [];
  const missing = [];
  let cur = inputPath;

  if (clip?.zoomPunch || clip?.cameraShake || clip?.impactTint) {
    const fxOut = path.join(tmpDir, 'near_camfx.mp4');
    try {
      const { applyCameraFx } = require('./camera_fx');
      await applyCameraFx(cur, fxOut, {
        zoomPunch: clip.zoomPunch,
        cameraShake: clip.cameraShake,
        impactTint: clip.impactTint,
        previewFast: true,
        log: (m) => log(m),
      });
      if (fs.existsSync(fxOut) && fs.statSync(fxOut).size > 500) {
        cur = fxOut;
        applied.push('beats_fx');
      }
    } catch (e) {
      log(`[composition-preview] camera-fx skipped: ${e.message}`);
      missing.push('beats_fx');
    }
  }

  if (clip?.speedRamps) {
    const speedOut = path.join(tmpDir, 'near_speed.mp4');
    try {
      const { applySpeedRamps, normalizeSpeedRamps } = require('./speed_ramps');
      const ramps = normalizeSpeedRamps(clip.speedRamps);
      if (ramps.length) {
        await applySpeedRamps(cur, speedOut, ramps, { log: (m) => log(m), previewFast: true });
        if (fs.existsSync(speedOut) && fs.statSync(speedOut).size > 500) {
          cur = speedOut;
          applied.push('speed_ramps');
        }
      }
    } catch (e) {
      log(`[composition-preview] speed-ramps skipped: ${e.message}`);
      missing.push('speed_ramps');
    }
  }

  // Transform = Punch/look + vignette + grain + badge (assembly path)
  const txOut = path.join(tmpDir, 'near_tx.mp4');
  let transformOk = false;
  try {
    const { applyClipCompTransform } = require('./assembly_postprocess');
    const creative = { ...(compCreative || {}) };
    // Prefer request creative.animatedText (Compose DOM / gap pack) over clip — Beats→FX
    // used to shrink clip.overlayTexts to a 2.2s peak Gemini stills miss.
    // Operator OFF (enabled:false or empty creative after clearing the field) must NOT
    // resurrect sticky clip.overlayTexts from an earlier Beats/gap pass.
    if (compCreative?.animatedText && compCreative.animatedText.enabled === false) {
      delete creative.animatedText;
    } else if (compCreative?.animatedText?.items?.length || compCreative?.animatedText?.text) {
      creative.animatedText = compCreative.animatedText;
    } else if (clip?.overlayTexts?.length) {
      creative.animatedText = { enabled: true, items: clip.overlayTexts };
    }
    const hasAnim = !!(creative.animatedText
      && creative.animatedText.enabled !== false
      && (creative.animatedText.items?.length || creative.animatedText.text));
    const ok = await applyClipCompTransform(cur, txOut, {
      contentType: 'twitch-short',
      designSpec: { compCreative: creative, lookPreset: creative.look?.preset },
      asmId: 'tlprev',
      previewFast: true,
      log: (m) => log(m),
    });
    if (ok && fs.existsSync(txOut) && fs.statSync(txOut).size > 500) {
      cur = txOut;
      applied.push('look_transform');
      if (hasAnim) applied.push('anim_text');
      else missing.push('anim_text');
      transformOk = true;
    }
  } catch (e) {
    log(`[composition-preview] transform skipped: ${e.message}`);
  }
  if (!transformOk) {
    const lookPath = path.join(tmpDir, 'near_look.mp4');
    const afterLook = await applyLookTintPreview(cur, lookPath, compCreative, log);
    if (afterLook !== cur) {
      cur = afterLook;
      applied.push('look_tint');
    } else if (compCreative?.look?.preset && compCreative.look.preset !== 'auto') {
      missing.push('look');
    }
  }

  const audioCreative = {
    ...(compCreative || {}),
    audio: {
      ...(compCreative?.audio || {}),
      highlightSfx: clip?.highlightSfx || compCreative?.audio?.highlightSfx || null,
    },
  };
  // Operator Music bed OFF — never mix catalog bed (Beats highlight SFX may still run)
  if (!audioCreative.audio.musicBed || audioCreative.audio.musicBed === 'off') {
    audioCreative.audio.musicBed = 'off';
    audioCreative.audio.bedPerSegment = false;
  }
  const { shouldMixCompAudio, mixCompAudio } = require('./clip_comp_audio_mix');
  if (shouldMixCompAudio(audioCreative)) {
    const mixOut = path.join(tmpDir, 'near_mix.mp4');
    try {
      const mixed = await mixCompAudio(cur, mixOut, {
        compCreative: audioCreative,
        clipDurationsSec: [Math.max(1, Number(previewDur) || 30)],
        log: (m) => log(m),
      });
      if (mixed !== false && fs.existsSync(mixOut) && fs.statSync(mixOut).size > 500) {
        cur = mixOut;
        applied.push('music_bed_sfx');
      }
    } catch (e) {
      log(`[composition-preview] audio mix skipped: ${e.message}`);
      missing.push('music_bed_sfx');
    }
  }

  // Whisper captions stay EXECUTE-only (too slow for interactive Review).
  const hookMode = compCreative?.hooks?.mode || 'both';
  const whisperOn = compCreative?.captions?.whisper !== false && hookMode !== 'hook_only';
  if (whisperOn) missing.push('whisper_captions');

  log(`[composition-preview] near-final applied=[${applied.join(',') || 'none'}] missing=[${missing.join(',') || 'none'}]`);
  return { path: cur, applied, missing };
}

function resolveSourceReviewWindow(trimStart, trimEnd, maxSec = MAX_SOURCE_REVIEW_SEC) {
  const start = Math.max(0, Number(trimStart) || 0);
  const end = trimEnd != null ? Number(trimEnd) : start + 60;
  const requested = Math.max(1, end - start);
  const windowSec = Math.min(requested, maxSec);
  return {
    trimStart: start,
    trimEnd: start + windowSec,
    windowSec,
    capped: start + windowSec < end,
  };
}

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 80 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(String(stdout || '').trim());
    });
  });
}

async function findLocalAssemblyClipPath(clip) {
  const fs = require('fs');
  const path = require('path');
  if (clip?.localClipPath && fs.existsSync(clip.localClipPath)) return clip.localClipPath;
  const tmpDir = path.join(__dirname, '../tmp');
  if (!fs.existsSync(tmpDir)) return null;
  const hints = [clip?.assemblyId, clip?.jobId, clip?.sourceJobId].filter(Boolean);
  const files = fs.readdirSync(tmpDir);
  for (const hint of hints) {
    const prefix = String(hint).startsWith('asm_') ? String(hint) : `asm_${hint}`;
    const match = files.find((f) => f.startsWith(prefix) && /_0_clip_1\.mp4$/i.test(f));
    if (match) return path.join(tmpDir, match);
  }
  return null;
}

async function downloadClipSnippet({
  mp4Url,
  pageUrl,
  trimStart = 0,
  trimEnd,
  quality,
  localClipPath,
  twitchClient,
  log = console.log,
  maxPreviewSec = MAX_PREVIEW_SEC,
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-prev-'));
  const rawPath = path.join(tmpDir, 'raw.mp4');
  const start = Math.max(0, Number(trimStart) || 0);
  const end = trimEnd != null ? Number(trimEnd) : start + 30;
  const cap = Math.max(1, Number(maxPreviewSec) || MAX_PREVIEW_SEC);
  const dur = Math.min(Math.max(1, end - start), cap);

  const trimFromFile = async (inputPath) => {
    if (start <= 0 && dur >= 120) {
      fs.copyFileSync(inputPath, rawPath);
      return;
    }
    await execFileAsync(ffmpegPath(), [
      '-y', '-ss', String(start), '-i', inputPath,
      '-t', String(dur),
      '-c:v', 'libx264', '-crf', '26', '-preset', 'ultrafast',
      '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart',
      rawPath,
    ], { timeout: 120000 });
  };

  const localPath = localClipPath || null;
  if (localPath && fs.existsSync(localPath)) {
    log(`[composition-preview] snippet ${dur}s from local cache ${path.basename(localPath)}`);
    await trimFromFile(localPath);
  } else if (needsYtdlpDownload({ mp4Url, pageUrl, quality })) {
    await downloadMediaToFile({ mp4Url, pageUrl, outPath: rawPath, quality, log, timeoutMs: 120000 });
    if (start > 0 || dur < 120) {
      const trimmed = path.join(tmpDir, 'trim.mp4');
      await execFileAsync(ffmpegPath(), [
        '-y', '-ss', String(start), '-i', rawPath,
        '-t', String(dur),
        '-c:v', 'libx264', '-crf', '26', '-preset', 'ultrafast',
        '-c:a', 'aac', '-b:a', '96k',
        '-movflags', '+faststart',
        trimmed,
      ], { timeout: 90000 });
      fs.renameSync(trimmed, rawPath);
    }
  } else {
    const input = mp4Url || pageUrl;
    if (!input) throw new Error('No clip URL for preview');
    try {
      await execFileAsync(ffmpegPath(), [
        '-y', '-ss', String(start), '-i', input,
        '-t', String(dur),
        '-c:v', 'libx264', '-crf', '26', '-preset', 'ultrafast',
        '-c:a', 'aac', '-b:a', '96k',
        '-movflags', '+faststart',
        rawPath,
      ], { timeout: 120000 });
    } catch (cdnErr) {
      log(`[composition-preview] CDN fetch failed (${cdnErr.message}) — resolving fresh clip URL`);
      const { resolveClipUrl } = require('./pickers/streamers/clip_resolve');
      const resolved = await resolveClipUrl({ url: pageUrl || mp4Url, platform: 'twitch' }, { twitchClient });
      if (!resolved?.mp4Url) throw cdnErr;
      await execFileAsync(ffmpegPath(), [
        '-y', '-ss', String(start), '-i', resolved.mp4Url,
        '-t', String(dur),
        '-c:v', 'libx264', '-crf', '26', '-preset', 'ultrafast',
        '-c:a', 'aac', '-b:a', '96k',
        '-movflags', '+faststart',
        rawPath,
      ], { timeout: 120000 });
    }
  }

  if (!fs.existsSync(rawPath) || fs.statSync(rawPath).size < 500) {
    throw new Error('Preview snippet download failed');
  }
  log(`[composition-preview] snippet ${dur}s from ${start}s`);
  return { tmpDir, rawPath };
}

async function applyLogoOverlay(inputPath, outputPath, compCreative) {
  if (!fs.existsSync(LOGO_PATH)) {
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }
  const logoMode = compCreative?.layout?.logo;
  if (logoMode === 'off') {
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }
  const filt = buildClipCompLogoFilter(compCreative, LOGO_PATH);
  if (!filt) {
    fs.copyFileSync(inputPath, outputPath);
    return outputPath;
  }
  await execFileAsync(ffmpegPath(), [
    '-y', '-i', inputPath, '-i', LOGO_PATH,
    '-filter_complex', filt,
    '-map', '[vout]', '-map', '0:a?',
    '-c:v', 'libx264', '-crf', '24', '-preset', 'ultrafast',
    '-c:a', 'copy', '-movflags', '+faststart',
    outputPath,
  ], { timeout: 90000 });
  return outputPath;
}

async function extractJpegFrame(videoPath, jpegPath, atSec = 1) {
  await execFileAsync(ffmpegPath(), [
    '-y', '-ss', String(Math.max(0, atSec)), '-i', videoPath,
    '-frames:v', '1', '-q:v', '3', '-vf', 'scale=540:-1',
    jpegPath,
  ], { timeout: 60000 });
  if (!fs.existsSync(jpegPath)) throw new Error('Frame extract failed');
  return jpegPath;
}

async function scalePreviewMp4(inputPath, outputPath, deliveryAspect = '9:16', maxWidth = 540, { allowCopy = false } = {}) {
  // CPD-1291 fix: near-final stack already outputs 1080 portrait — re-encode was hanging Review.
  if (allowCopy && deliveryAspect !== '1:1') {
    try {
      const dims = await probeVideoDimensions(inputPath);
      const w = Math.max(360, Number(maxWidth) || 540);
      if (dims?.width && dims.width <= w + 8 && dims.height >= dims.width) {
        fs.copyFileSync(inputPath, outputPath);
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 500) return outputPath;
      }
    } catch (_) { /* fall through to encode */ }
  }
  const w = Math.max(360, Number(maxWidth) || 540);
  const vf = deliveryAspect === '1:1'
    ? `scale=${w}:${w}:force_original_aspect_ratio=decrease,pad=${w}:${w}:(ow-iw)/2:(oh-ih)/2:black`
    : `scale=${w}:-2`;
  await execFileAsync(ffmpegPath(), [
    '-y', '-loglevel', 'error', '-i', inputPath,
    '-vf', vf,
    '-c:v', 'libx264', '-crf', '28', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k',
    '-movflags', '+faststart',
    outputPath,
  ], { timeout: 120000 });
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 500) {
    throw new Error('Preview video encode failed');
  }
  return outputPath;
}

function buildLayoutSummary(compCreative, effectiveMode, facecamRect, extras = {}) {
  const layout = compCreative?.layout || {};
  const requestedMode = resolveLayoutMode(compCreative);
  const topHeight = resolveSplitTopHeight(compCreative);
  const applied = extras.appliedSourceRect || null;
  return {
    effectiveMode,
    requestedMode,
    landscapeAutoSplit: effectiveMode === 'split_screen' && requestedMode !== 'split_screen',
    topHeight: effectiveMode === 'split_screen' ? topHeight : null,
    contentCx: layout.contentCx != null ? Number(layout.contentCx) : null,
    facecamRect: facecamRect || layout.facecamRect || null,
    bottomPaneRect: layout.bottomPaneRect || null,
    bottomPaneMode: layout.bottomPaneMode || 'wide_pan',
    cropCx: layout.cropCx != null ? Number(layout.cropCx) : null,
    cropCy: layout.cropCy != null ? Number(layout.cropCy) : null,
    cropZoom: layout.cropZoom != null ? Number(layout.cropZoom) : null,
    sourceAspect: extras.sourceAspect != null ? Number(extras.sourceAspect) : null,
    appliedSourceRect: applied,
    logoCorner: layout.logoCorner || null,
  };
}

async function resolveClipMp4(clip, twitchClient) {
  const { isDirectMediaUrl } = require('./content_library/media_download');
  const staged = clip.mp4Url || clip.r2Url || clip.stagedUrl;
  if (staged) return staged;
  const directUrl = clip.url || clip.pageUrl || '';
  if (directUrl && isDirectMediaUrl(directUrl)) return directUrl;
  const { resolveClipUrl } = require('./pickers/streamers/clip_resolve');
  const url = clip.pageUrl || clip.url;
  const result = await resolveClipUrl({ url, platform: clip.platform }, { twitchClient });
  if (!result?.mp4Url) throw new Error('Could not resolve clip MP4');
  return result.mp4Url;
}

function previewDurationSec(clip = {}) {
  const trimStart = Math.max(0, Number(clip.trimStart) || 0);
  const trimEnd = clip.trimEnd != null ? Number(clip.trimEnd) : trimStart + 30;
  const trimDur = Math.max(1, trimEnd - trimStart);
  const segments = Array.isArray(clip.layoutSegments) ? clip.layoutSegments : [];
  if (!segments.length) return Math.min(trimDur, MAX_PREVIEW_SEC);
  const lastBp = segments.reduce((max, s) => Math.max(max, Number(s.atSec) || 0), trimStart);
  const relLast = Math.max(0, lastBp - trimStart);
  return Math.min(trimDur, Math.max(12, relLast + 6), MAX_TIMED_PREVIEW_SEC);
}

/** Full trim window for Compose timeline editor — same cap as source review. */
function timelinePreviewDurationSec(clip = {}) {
  const trimStart = Math.max(0, Number(clip.trimStart) || 0);
  const trimEnd = clip.trimEnd != null ? Number(clip.trimEnd) : trimStart + 30;
  const trimDur = Math.max(1, trimEnd - trimStart);
  return Math.min(trimDur, MAX_TIMELINE_PREVIEW_SEC);
}

/**
 * Render a portrait comp preview JPEG from clip + compCreative (layout + logo).
 * Returns { jpegPath, base64, mode } — caller may serve or return base64.
 */
async function renderCompositionPreview({
  clip,
  compCreativePreset = 'classic_blur_pad',
  compCreativeOverrides = {},
  hookText = 'Hook Preview',
  deliveryAspect = '9:16',
  twitchClient = null,
  log = console.log,
  fullTrimWindow = false,
}) {
  const compCreative = mergeCompCreative({
    preset: compCreativePreset,
    overrides: {
      ...compCreativeOverrides,
      ...(fullTrimWindow ? { previewFast: true } : {}),
    },
    streamerHint: clip?.streamer || clip?.displayName || null,
  });

  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  const jobId = `${fullTrimWindow ? 'tlprev' : 'prev'}_${Date.now()}`;
  const outJpeg = path.join(PREVIEW_DIR, `${jobId}.jpg`);
  const outMp4 = path.join(PREVIEW_DIR, `${jobId}.mp4`);

  let tmpDir;
  try {
    const mp4Url = clip.resolvedMp4 || await resolveClipMp4(clip, twitchClient);
    const localClipPath = clip.localClipPath || await findLocalAssemblyClipPath(clip);
    const previewDur = fullTrimWindow ? timelinePreviewDurationSec(clip) : previewDurationSec(clip);
    const layoutSegments = Array.isArray(clip.layoutSegments) ? clip.layoutSegments : [];
    const openingLayout = clip.openingLayout || null;
    const hasTimedLayout = layoutSegments.length > 0 || !!openingLayout;
    const snippet = await downloadClipSnippet({
      mp4Url,
      pageUrl: clip.pageUrl || clip.url,
      trimStart: clip.trimStart,
      trimEnd: clip.trimEnd,
      localClipPath,
      twitchClient,
      log,
      maxPreviewSec: previewDur,
    });
    tmpDir = snippet.tmpDir;
    let { rawPath } = snippet;

    if (fullTrimWindow) {
      const scaledPath = path.join(tmpDir, 'scaled.mp4');
      rawPath = await downscalePreviewSource(rawPath, scaledPath, log);
    }

    const { applySourceCleanup } = require('./source_cleanup');
    const cleanPath = path.join(tmpDir, 'clean.mp4');
    rawPath = await applySourceCleanup(rawPath, cleanPath, {
      compCreative,
      log: (m) => log(m),
      previewFast: fullTrimWindow,
    });

    const layoutPath = path.join(tmpDir, 'layout.mp4');
    const trimStart = Math.max(0, Number(clip.trimStart) || 0);
    const trimEnd = clip.trimEnd != null ? Number(clip.trimEnd) : trimStart + previewDur;
    let effectiveMode;
    let facecamRect;
    const sourceDims = await probeVideoDimensions(rawPath);
    let appliedSourceRect = null;

    if (hasTimedLayout) {
      const timedEnd = fullTrimWindow
        ? (clip.trimEnd != null ? Number(clip.trimEnd) : trimStart + previewDur)
        : Math.min(trimEnd, trimStart + previewDur);
      log(`[composition-preview] timed layout: ${layoutSegments.length} breakpoint(s)`
        + (openingLayout ? ' + openingLayout' : '')
        + `, ${previewDur}s window${fullTrimWindow ? ' (full trim)' : ''}`);
      await applyPortraitLayoutTimed(rawPath, layoutPath, {
        compCreative: { ...compCreative, previewFast: fullTrimWindow },
        trimStart,
        trimEnd: timedEnd,
        layoutSegments,
        openingLayout,
        deliveryAspect,
        sourceFilePreTrimmed: true,
        log: (m) => log(m),
      });
      effectiveMode = (layoutSegments.length
        ? layoutSegments[layoutSegments.length - 1]?.mode
        : openingLayout?.mode) || compCreative?.layout?.mode;
    } else {
      const resolved = await resolveEffectiveLayoutMode(rawPath, compCreative, log);
      effectiveMode = resolved.mode;
      facecamRect = resolved.facecamRect;
      if (effectiveMode === 'full_bleed_crop') {
        const subject = await resolveFullBleedSubject(rawPath, compCreative, log);
        appliedSourceRect = resolveFullBleedSourceRect(
          subject.subjectCx ?? 0.5,
          subject.subjectCy ?? 0.5,
          subject.cropZoom ?? 1,
          sourceDims?.aspect ?? 16 / 9,
        );
      }
      await applyPortraitLayout(rawPath, layoutPath, {
        compCreative,
        log: (m) => log(m),
        effectiveMode,
        facecamRect,
        deliveryAspect,
      });
    }

    const logoPath = path.join(tmpDir, 'logo.mp4');
    await applyLogoOverlay(layoutPath, logoPath, compCreative);

    // CPD-1291: Review (fullTrimWindow) gets near-final stack; quick preview keeps look tint only.
    let gradedPath = logoPath;
    let nearFinalApplied = [];
    let nearFinalMissing = [];
    if (fullTrimWindow) {
      const near = await applyNearFinalPreviewStack(logoPath, tmpDir, {
        clip,
        compCreative,
        previewDur,
        log,
      });
      gradedPath = near.path;
      nearFinalApplied = near.applied || [];
      nearFinalMissing = near.missing || [];
    } else {
      const lookPath = path.join(tmpDir, 'look.mp4');
      gradedPath = await applyLookTintPreview(logoPath, lookPath, compCreative, log);
    }

    const jpegAt = hasTimedLayout ? Math.min(previewDur * 0.45, previewDur - 0.5) : 0.5;
    await extractJpegFrame(gradedPath, outJpeg, jpegAt);
    let previewVideoUrl = null;
    let previewVideoError = null;
    try {
      await scalePreviewMp4(gradedPath, outMp4, deliveryAspect, fullTrimWindow ? 1080 : 720, {
        allowCopy: !!fullTrimWindow,
      });
      previewVideoUrl = `/composition/preview/file/${path.basename(outMp4)}`;
    } catch (vidErr) {
      previewVideoError = vidErr.message;
      log(`[composition-preview] video encode skipped: ${vidErr.message}`);
    }

    const base64 = fs.readFileSync(outJpeg).toString('base64');
    const layoutSummary = buildLayoutSummary(compCreative, effectiveMode, facecamRect, {
      appliedSourceRect,
      sourceAspect: sourceDims?.aspect ?? null,
    });
    const { sourceCleanupSummary } = require('./source_cleanup');
    const cleanupLabel = sourceCleanupSummary(compCreative?.sourceCleanup);
    return {
      ok: true,
      previewPath: outJpeg,
      previewUrl: `/composition/preview/file/${path.basename(outJpeg)}`,
      previewVideoUrl,
      previewVideoPath: previewVideoUrl ? outMp4 : null,
      previewVideoError,
      previewVideoMime: previewVideoUrl ? 'video/mp4' : null,
      previewDurationSec: previewDur,
      fullTrimWindow: !!fullTrimWindow,
      nearFinalPreview: !!fullTrimWindow,
      nearFinalApplied,
      nearFinalMissing,
      trimStart,
      trimEnd: clip.trimEnd != null ? Number(clip.trimEnd) : trimStart + previewDur,
      timedLayoutPreview: hasTimedLayout,
      base64,
      mimeType: 'image/jpeg',
      mode: effectiveMode,
      requestedMode: layoutSummary.requestedMode,
      landscapeAutoSplit: layoutSummary.landscapeAutoSplit,
      layoutSummary: {
        ...layoutSummary,
        sourceCleanup: cleanupLabel || null,
        timedLayout: hasTimedLayout,
        nearFinal: !!fullTrimWindow,
        nearFinalApplied,
        nearFinalMissing,
      },
      hookText: compCreative?.hooks?.mode === 'whisper_only' ? null : hookText,
    };
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
    }
  }
}

async function renderVodSegmentPreview({
  vodUrl,
  startSec = 0,
  endSec,
  durationSec,
  compCreativePreset = 'classic_blur_pad',
  compCreativeOverrides = {},
  deliveryAspect = '9:16',
  log = console.log,
}) {
  const { resolveVodStreamUrl } = require('./content_library/vod_frame_samples');
  const { execFile } = require('child_process');
  const { ffmpegPath } = require('./ffmpeg_utils');

  const start = Math.max(0, Number(startSec) || 0);
  const end = endSec != null ? Number(endSec) : start + 420;
  const dur = durationSec || end;
  const sampleAt = Math.floor(start + Math.min(30, Math.max(1, (end - start) / 2)));

  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  const jobId = `vodprev_${Date.now()}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vod-prev-'));
  const rawFrame = path.join(tmpDir, 'frame.jpg');
  const outJpeg = path.join(PREVIEW_DIR, `${jobId}.jpg`);

  try {
    const streamUrl = await resolveVodStreamUrl(vodUrl);
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath(), [
        '-y', '-ss', String(sampleAt), '-i', streamUrl,
        '-frames:v', '1', '-q:v', '3', rawFrame,
      ], { timeout: 120000 }, (err) => (err ? reject(err) : resolve()));
    });
    if (!fs.existsSync(rawFrame)) throw new Error('VOD frame extract failed');

    const loopVideo = path.join(tmpDir, 'loop.mp4');
    await new Promise((resolve, reject) => {
      execFile(ffmpegPath(), [
        '-y', '-loop', '1', '-i', rawFrame, '-t', '2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
        loopVideo,
      ], { timeout: 60000 }, (err) => (err ? reject(err) : resolve()));
    });

    const compCreative = mergeCompCreative({
      preset: compCreativePreset,
      overrides: compCreativeOverrides,
    });
    const layoutPath = path.join(tmpDir, 'layout.mp4');
    await applyPortraitLayout(loopVideo, layoutPath, { compCreative, log: (m) => log(m), deliveryAspect });
    const logoPath = path.join(tmpDir, 'logo.mp4');
    await applyLogoOverlay(layoutPath, logoPath, compCreative);
    await extractJpegFrame(logoPath, outJpeg, 0.3);

    const base64 = fs.readFileSync(outJpeg).toString('base64');
    return {
      ok: true,
      previewPath: outJpeg,
      previewUrl: `/composition/preview/file/${path.basename(outJpeg)}`,
      base64,
      mimeType: 'image/jpeg',
      mode: resolveLayoutMode(compCreative),
      segment: { start_sec: start, end_sec: end, duration_sec: end - start },
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
  }
}

/**
 * Full source clip for Compose review (trim window, up to MAX_SOURCE_REVIEW_SEC).
 * Returns a localhost URL — avoids expired Twitch CDN tokens in the browser.
 */
async function prepareComposerSourceReview({
  clip,
  vodSegment = null,
  twitchClient = null,
  sourceCleanup = null,
  compCreative = null,
  log = console.log,
}) {
  cleanupOldPreviews();
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });

  let trimStart = 0;
  let trimEnd = 60;
  let reviewClip = clip;

  if (vodSegment?.vodUrl) {
    trimStart = Math.max(0, Number(vodSegment.start_sec) || 0);
    trimEnd = Number(vodSegment.end_sec) != null ? Number(vodSegment.end_sec) : trimStart + 420;
    reviewClip = {
      url: vodSegment.vodUrl,
      pageUrl: vodSegment.vodUrl,
      platform: vodSegment.platform || 'youtube',
      trimStart,
      trimEnd,
      resolvedMp4: vodSegment.stagedUrl || vodSegment.r2Url || vodSegment.mp4Url || null,
    };
  } else if (clip) {
    trimStart = Math.max(0, Number(clip.trimStart) || 0);
    trimEnd = clip.trimEnd != null ? Number(clip.trimEnd) : trimStart + 60;
  } else {
    throw new Error('clip or vodSegment required');
  }

  const win = resolveSourceReviewWindow(trimStart, trimEnd);
  trimStart = win.trimStart;
  const windowSec = win.windowSec;
  const effectiveEnd = win.trimEnd;
  const trimEndRequested = trimEnd;
  trimEnd = effectiveEnd;
  let tmpDir;
  try {
    let reviewInput;
    const stagedMp4 = reviewClip.resolvedMp4
      || vodSegment?.stagedUrl
      || vodSegment?.r2Url
      || null;

    // CPD-1270: R2-staged peak windows — remux only (no crush). Matches library clip quality.
    if (stagedMp4 && /^https?:\/\//i.test(stagedMp4)) {
      tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'comp-srcrev-r2-'));
      const localStaged = path.join(tmpDir, 'staged.mp4');
      await downloadMediaToFile({
        mp4Url: stagedMp4,
        pageUrl: stagedMp4,
        outPath: localStaged,
        log,
        timeoutMs: 180000,
      });
      reviewInput = localStaged;
      log(`[composition-preview] source-review from R2 staged window (${Math.round(fs.statSync(localStaged).size / 1024)}KB)`);
    } else if (vodSegment?.vodUrl) {
      // Peak window: section download (not full VOD) then light remux
      const { getOrExtractPreviewMp4 } = require('./post_live/vod_preview');
      const { extractClipIdFromUrl } = require('./content_library/clip_ids');
      const videoId = vodSegment.vodId || extractClipIdFromUrl(vodSegment.vodUrl) || `vod_${Date.now()}`;
      const extracted = await getOrExtractPreviewMp4({
        videoId: String(videoId),
        vodUrl: vodSegment.vodUrl,
        start_s: trimStart,
        end_s: effectiveEnd,
      });
      const src = path.join(require('./post_live/vod_preview').TMP_DIR, extracted.filename);
      if (!fs.existsSync(src)) throw new Error('VOD window extract missing');
      tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'comp-srcrev-vod-'));
      reviewInput = path.join(tmpDir, 'win.mp4');
      fs.copyFileSync(src, reviewInput);
      log(`[composition-preview] source-review from yt-dlp section (${extracted.method || 'cached'})`);
    } else {
      const mp4Url = reviewClip.resolvedMp4 || await resolveClipMp4(reviewClip, twitchClient);
      const localClipPath = reviewClip.localClipPath || await findLocalAssemblyClipPath(reviewClip);
      const snippet = await downloadClipSnippet({
        mp4Url,
        pageUrl: reviewClip.pageUrl || reviewClip.url,
        trimStart,
        trimEnd: effectiveEnd,
        localClipPath,
        twitchClient,
        log,
        maxPreviewSec: windowSec,
      });
      tmpDir = snippet.tmpDir;
      reviewInput = snippet.rawPath;
    }

    const cleanupCfg = sourceCleanup || compCreative?.sourceCleanup || null;
    if (cleanupCfg) {
      const { applySourceCleanup } = require('./source_cleanup');
      const cleanPath = path.join(tmpDir || PREVIEW_DIR, `srcrev_clean_${Date.now()}.mp4`);
      reviewInput = await applySourceCleanup(reviewInput, cleanPath, {
        sourceCleanup: cleanupCfg,
        log: (m) => log(m),
        previewFast: false,
      });
    }

    const outName = `srcrev_${Date.now()}.mp4`;
    const outPath = path.join(PREVIEW_DIR, outName);
    // CPD-1270: operator review quality — ~720p, not 854/CRF28 crush
    await execFileAsync(ffmpegPath(), [
      '-y', '-i', reviewInput,
      '-vf', 'scale=1280:-2',
      '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      outPath,
    ], { timeout: 300000 });
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 500) {
      throw new Error('Source review encode failed');
    }
    const reviewIsWindowFile = !!(stagedMp4 || vodSegment?.vodUrl);
    return {
      ok: true,
      reviewUrl: `/composition/source-review/file/${outName}`,
      filePath: outPath,
      // Staged/section files are already cut — timeline is 0-based on the review MP4.
      // Absolute peak times stay on vodSegment for assembly extract.
      durationSec: reviewIsWindowFile ? Math.max(1, effectiveEnd - trimStart) : windowSec,
      trimStart: reviewIsWindowFile ? 0 : trimStart,
      trimEnd: reviewIsWindowFile ? Math.max(1, effectiveEnd - trimStart) : effectiveEnd,
      trimEndRequested,
      sourceStartSec: trimStart,
      sourceEndSec: effectiveEnd,
      capped: win.capped,
      clipTitle: (clip && clip.title) || vodSegment?.title || '',
      fromR2: !!stagedMp4,
    };
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* noop */ }
    }
  }
}

function cleanupOldPreviews(maxAgeMs = 3600000) {
  try {
    if (!fs.existsSync(PREVIEW_DIR)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(PREVIEW_DIR)) {
      const p = path.join(PREVIEW_DIR, f);
      try {
        if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p);
      } catch (_) { /* noop */ }
    }
  } catch (_) { /* noop */ }
}

/** Full trim-window portrait preview for Compose timeline editor (CPD-1243). */
async function renderCompositionTimelinePreview(opts) {
  return runTimelinePreviewExclusive(() => renderCompositionPreview({ ...opts, fullTrimWindow: true }));
}

module.exports = {
  renderCompositionPreview,
  renderCompositionTimelinePreview,
  runTimelinePreviewExclusive,
  renderVodSegmentPreview,
  prepareComposerSourceReview,
  resolveSourceReviewWindow,
  timelinePreviewDurationSec,
  applyNearFinalPreviewStack,
  cleanupOldPreviews,
  PREVIEW_DIR,
  MAX_SOURCE_REVIEW_SEC,
  MAX_TIMELINE_PREVIEW_SEC,
};
