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
  buildClipCompLogoFilter,
  resolveLayoutMode,
  resolveEffectiveLayoutMode,
  resolveSplitTopHeight,
} = require('./clip_comp_layout');

const PREVIEW_DIR = path.join(__dirname, '../tmp/composition_preview');
const LOGO_PATH = path.join(__dirname, '../assets/cwn_logo.png');
const MAX_PREVIEW_SEC = 6;
/** Full trim-window review in Compose (CPD-1234) — not the 6s layout preview loop. */
const MAX_SOURCE_REVIEW_SEC = 180;

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

async function scalePreviewMp4(inputPath, outputPath, deliveryAspect = '9:16') {
  const vf = deliveryAspect === '1:1'
    ? 'scale=540:540:force_original_aspect_ratio=decrease,pad=540:540:(ow-iw)/2:(oh-ih)/2:black'
    : 'scale=540:-2';
  await execFileAsync(ffmpegPath(), [
    '-y', '-i', inputPath,
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

function buildLayoutSummary(compCreative, effectiveMode, facecamRect) {
  const layout = compCreative?.layout || {};
  const requestedMode = resolveLayoutMode(compCreative);
  const topHeight = resolveSplitTopHeight(compCreative);
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
}) {
  const compCreative = mergeCompCreative({
    preset: compCreativePreset,
    overrides: compCreativeOverrides,
    streamerHint: clip?.streamer || clip?.displayName || null,
  });

  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  const jobId = `prev_${Date.now()}`;
  const outJpeg = path.join(PREVIEW_DIR, `${jobId}.jpg`);
  const outMp4 = path.join(PREVIEW_DIR, `${jobId}.mp4`);

  let tmpDir;
  try {
    const mp4Url = clip.resolvedMp4 || await resolveClipMp4(clip, twitchClient);
    const localClipPath = clip.localClipPath || await findLocalAssemblyClipPath(clip);
    const snippet = await downloadClipSnippet({
      mp4Url,
      pageUrl: clip.pageUrl || clip.url,
      trimStart: clip.trimStart,
      trimEnd: clip.trimEnd,
      localClipPath,
      twitchClient,
      log,
    });
    tmpDir = snippet.tmpDir;
    const { rawPath } = snippet;

    const layoutPath = path.join(tmpDir, 'layout.mp4');
    const { mode: effectiveMode, facecamRect } = await resolveEffectiveLayoutMode(rawPath, compCreative, log);
    await applyPortraitLayout(rawPath, layoutPath, {
      compCreative,
      log: (m) => log(m),
      effectiveMode,
      facecamRect,
      deliveryAspect,
    });

    const logoPath = path.join(tmpDir, 'logo.mp4');
    await applyLogoOverlay(layoutPath, logoPath, compCreative);

    await extractJpegFrame(logoPath, outJpeg, 0.5);
    let previewVideoUrl = null;
    let previewVideoError = null;
    try {
      await scalePreviewMp4(logoPath, outMp4, deliveryAspect);
      previewVideoUrl = `/composition/preview/file/${path.basename(outMp4)}`;
    } catch (vidErr) {
      previewVideoError = vidErr.message;
      log(`[composition-preview] video encode skipped: ${vidErr.message}`);
    }

    const base64 = fs.readFileSync(outJpeg).toString('base64');
    const layoutSummary = buildLayoutSummary(compCreative, effectiveMode, facecamRect);
    return {
      ok: true,
      previewPath: outJpeg,
      previewUrl: `/composition/preview/file/${path.basename(outJpeg)}`,
      previewVideoUrl,
      previewVideoError,
      previewVideoMime: previewVideoUrl ? 'video/mp4' : null,
      base64,
      mimeType: 'image/jpeg',
      mode: effectiveMode,
      requestedMode: layoutSummary.requestedMode,
      landscapeAutoSplit: layoutSummary.landscapeAutoSplit,
      layoutSummary,
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
      platform: 'youtube',
      trimStart,
      trimEnd,
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
    const outName = `srcrev_${Date.now()}.mp4`;
    const outPath = path.join(PREVIEW_DIR, outName);
    await execFileAsync(ffmpegPath(), [
      '-y', '-i', snippet.rawPath,
      '-vf', 'scale=854:-2',
      '-c:v', 'libx264', '-crf', '28', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart',
      outPath,
    ], { timeout: 300000 });
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 500) {
      throw new Error('Source review encode failed');
    }
    return {
      ok: true,
      reviewUrl: `/composition/source-review/file/${outName}`,
      filePath: outPath,
      durationSec: windowSec,
      trimStart,
      trimEnd: effectiveEnd,
      trimEndRequested,
      capped: win.capped,
      clipTitle: (clip && clip.title) || vodSegment?.title || '',
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

module.exports = {
  renderCompositionPreview,
  renderVodSegmentPreview,
  prepareComposerSourceReview,
  resolveSourceReviewWindow,
  cleanupOldPreviews,
  PREVIEW_DIR,
  MAX_SOURCE_REVIEW_SEC,
};
