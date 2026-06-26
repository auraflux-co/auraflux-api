'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { uploadToR2, isR2Configured } = require('../storage');
const { ffmpegPath } = require('../ffmpeg_utils');
const { resolveClipUrl } = require('../pickers/streamers/clip_resolve');
const { extractClipIdFromUrl } = require('./clip_ids');
const { stagingExpiresAtMs } = require('./time_et');
const {
  getStagedClipByUrl,
  upsertStagedClip,
  formatStagedClip,
} = require('./staged_store');

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

function stagingFolder() {
  return process.env.R2_LIBRARY_FOLDER || 'library-staging';
}

async function downloadClipToFile({ mp4Url, pageUrl, outPath, log = console.log }) {
  const input = mp4Url || pageUrl;
  if (!input) throw new Error('No clip URL to download');
  await execFileAsync(ffmpegPath(), [
    '-y', '-i', input,
    '-c', 'copy',
    '-movflags', '+faststart',
    outPath,
  ], { timeout: 300000 });
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 500) {
    throw new Error('Clip download produced empty file');
  }
  log(`[library-stage] downloaded ${Math.round(fs.statSync(outPath).size / 1024)}KB`);
}

function cleanupDir(dir) {
  try {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_e) { /* ignore */ }
}

/**
 * Download a clip to R2 for Library preview + Composer full-length edit.
 * Idempotent — returns existing row when still valid.
 */
async function stageClipToR2(input, { twitchClient, log = console.log, force = false } = {}) {
  const url = input?.url || input?.pageUrl || '';
  if (!url) throw new Error('clip url required');
  if (!isR2Configured()) {
    throw new Error('R2 not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  }

  const platform = input.platform || 'twitch';
  const streamer = String(input.streamer || 'unknown').toLowerCase();
  const clipId = input.clipId || extractClipIdFromUrl(url);
  if (!clipId) throw new Error('Could not parse clip id from URL');

  if (!force) {
    const existing = getStagedClipByUrl(url);
    if (existing?.status === 'ready' && existing.r2_url) {
      const expired = existing.expires_at && existing.expires_at < Date.now() && !existing.used_at;
      if (!expired) {
        return { ok: true, cached: true, ...formatStagedClip(existing) };
      }
    }
  }

  const resolved = await resolveClipUrl({ url, platform }, { twitchClient });
  const mp4Url = resolved?.mp4Url;
  if (!mp4Url) throw new Error('Could not resolve clip MP4');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-stage-'));
  const localPath = path.join(tmpDir, `${clipId}.mp4`);
  try {
    await downloadClipToFile({ mp4Url, pageUrl: url, outPath: localPath, log });
    const r2Key = `${stagingFolder()}/${streamer}/${clipId}.mp4`;
    const r2Url = await uploadToR2(localPath, `${clipId}.mp4`, {
      key: r2Key,
      contentType: 'video/mp4',
      cacheControl: 'public, max-age=604800',
    });
    const row = upsertStagedClip({
      platform,
      streamer,
      clip_id: clipId,
      url,
      title: input.title || resolved.title || null,
      duration_sec: input.duration || input.duration_sec || 0,
      thumbnail_url: input.thumbnailUrl || input.thumbnail_url || null,
      r2_key: r2Key,
      r2_url: r2Url,
      staged_at: Date.now(),
      expires_at: stagingExpiresAtMs(),
      status: 'ready',
      error: null,
    });
    log(`[library-stage] ${streamer}/${clipId} → ${r2Key}`);
    return { ok: true, cached: false, ...formatStagedClip(row) };
  } finally {
    cleanupDir(tmpDir);
  }
}

async function stageClipsBatch(clips = [], opts = {}) {
  const results = [];
  for (const clip of clips) {
    try {
      const out = await stageClipToR2(clip, opts);
      results.push({ ok: true, url: clip.url, ...out });
    } catch (err) {
      results.push({ ok: false, url: clip.url, error: err.message });
    }
  }
  return results;
}

module.exports = { stageClipToR2, stageClipsBatch, downloadClipToFile };
