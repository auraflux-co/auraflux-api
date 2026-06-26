'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');
const { mergeCompCreative } = require('./clip_comp_creative');
const { applyPortraitLayout, buildClipCompLogoFilter, resolveLayoutMode } = require('./clip_comp_layout');

const PREVIEW_DIR = path.join(__dirname, '../tmp/composition_preview');
const LOGO_PATH = path.join(__dirname, '../assets/cwn_logo.png');
const MAX_PREVIEW_SEC = 6;

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

async function downloadClipSnippet({ mp4Url, pageUrl, trimStart = 0, trimEnd, log = console.log }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-prev-'));
  const rawPath = path.join(tmpDir, 'raw.mp4');
  const start = Math.max(0, Number(trimStart) || 0);
  const end = trimEnd != null ? Number(trimEnd) : start + 30;
  const dur = Math.min(Math.max(1, end - start), MAX_PREVIEW_SEC);
  const input = mp4Url || pageUrl;
  if (!input) throw new Error('No clip URL for preview');

  await execFileAsync(ffmpegPath(), [
    '-y', '-ss', String(start), '-i', input,
    '-t', String(dur),
    '-c:v', 'libx264', '-crf', '26', '-preset', 'ultrafast',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    rawPath,
  ], { timeout: 120000 });

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

async function resolveClipMp4(clip, twitchClient) {
  const staged = clip.mp4Url || clip.r2Url || clip.stagedUrl;
  if (staged) return staged;
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

  let tmpDir;
  try {
    const mp4Url = clip.resolvedMp4 || await resolveClipMp4(clip, twitchClient);
    const snippet = await downloadClipSnippet({
      mp4Url,
      pageUrl: clip.pageUrl || clip.url,
      trimStart: clip.trimStart,
      trimEnd: clip.trimEnd,
      log,
    });
    tmpDir = snippet.tmpDir;
    const { rawPath } = snippet;

    const layoutPath = path.join(tmpDir, 'layout.mp4');
    await applyPortraitLayout(rawPath, layoutPath, { compCreative, log: (m) => log(m) });

    const logoPath = path.join(tmpDir, 'logo.mp4');
    await applyLogoOverlay(layoutPath, logoPath, compCreative);

    await extractJpegFrame(logoPath, outJpeg, 0.5);

    const base64 = fs.readFileSync(outJpeg).toString('base64');
    return {
      ok: true,
      previewPath: outJpeg,
      previewUrl: `/composition/preview/file/${path.basename(outJpeg)}`,
      base64,
      mimeType: 'image/jpeg',
      mode: resolveLayoutMode(compCreative),
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
    await applyPortraitLayout(loopVideo, layoutPath, { compCreative, log: (m) => log(m) });
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
  cleanupOldPreviews,
  PREVIEW_DIR,
};
