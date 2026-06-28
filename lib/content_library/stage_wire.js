'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { uploadToR2, isR2Configured } = require('../storage');
const { ffmpegPath } = require('../ffmpeg_utils');
const { stagingExpiresAtMs } = require('./time_et');
const {
  getStagedClipByUrl,
  getStagedClipByPlatformId,
  upsertStagedClip,
  formatStagedClip,
} = require('./staged_store');
const { attachPlaybackUrl } = require('./playback_url');

function stagingFolder() {
  return process.env.R2_LIBRARY_FOLDER || 'library-staging';
}

function cleanupDir(dir) {
  try {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_e) { /* ignore */ }
}

function wireClipId(input) {
  const id = String(input?.storyId || input?.id || input?.videoId || '').trim();
  if (id) return id.slice(0, 64);
  const link = String(input?.link || input?.url || input?.hlsUrl || '').trim();
  if (!link) throw new Error('wire story link or id required');
  return crypto.createHash('sha1').update(link).digest('hex').slice(0, 16);
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

async function downloadHlsToFile(hlsUrl, outPath, { maxSecs = 300, log = console.log } = {}) {
  const args = ['-y', '-i', hlsUrl, '-c', 'copy', '-movflags', '+faststart'];
  if (maxSecs > 0) args.splice(2, 0, '-t', String(maxSecs));
  args.push(outPath);
  await execFileAsync(ffmpegPath(), args, { timeout: 600000 });
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 500) {
    throw new Error('Wire HLS download produced empty file');
  }
  log(`[wire-stage] downloaded ${Math.round(fs.statSync(outPath).size / 1024)}KB`);
}

async function probeDurationSec(filePath) {
  try {
    const out = await execFileAsync(ffmpegPath(), [
      '-i', filePath, '-f', 'null', '-',
    ], { timeout: 120000 });
    void out;
  } catch (err) {
    const m = String(err.stderr || err.message || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) {
      return Math.round(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    }
  }
  return 0;
}

/**
 * Stage a wire news story HLS URL to R2 for Library preview + Composer.
 */
async function stageWireStoryToR2(input, { log = console.log, force = false } = {}) {
  const hlsUrl = input?.hlsUrl || input?.videoUrl || input?.url || '';
  if (!hlsUrl) throw new Error('hlsUrl required');
  if (!isR2Configured()) {
    throw new Error('R2 not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  }

  const sourceKey = String(input?.sourceKey || input?.source || 'wire').toLowerCase();
  const clipId = wireClipId(input);
  const canonicalUrl = input?.link || input?.articleUrl || hlsUrl;

  if (!force) {
    const existing = getStagedClipByPlatformId('wire', clipId)
      || getStagedClipByUrl(canonicalUrl)
      || getStagedClipByUrl(hlsUrl);
    if (existing?.status === 'ready' && existing.r2_url) {
      const expired = existing.expires_at && existing.expires_at < Date.now() && !existing.used_at;
      if (!expired) {
        const formatted = formatStagedClip(existing);
        await attachPlaybackUrl(formatted, existing);
        return { ok: true, cached: true, ...formatted };
      }
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-stage-'));
  const localPath = path.join(tmpDir, `${clipId}.mp4`);
  try {
    log(`[wire-stage] downloading ${hlsUrl.slice(0, 80)}…`);
    await downloadHlsToFile(hlsUrl, localPath, { maxSecs: 0, log });
    const durationSec = await probeDurationSec(localPath);
    const r2Key = `${stagingFolder()}/wire/${sourceKey}/${clipId}.mp4`;
    const r2Url = await uploadToR2(localPath, `${clipId}.mp4`, {
      key: r2Key,
      contentType: 'video/mp4',
      cacheControl: 'public, max-age=604800',
    });
    const row = upsertStagedClip({
      platform: 'wire',
      streamer: sourceKey,
      clip_id: clipId,
      url: canonicalUrl,
      title: input.title || null,
      duration_sec: durationSec || input.duration || 0,
      thumbnail_url: input.thumbnailUrl || input.thumbnail || null,
      r2_key: r2Key,
      r2_url: r2Url,
      staged_at: Date.now(),
      expires_at: stagingExpiresAtMs(),
      status: 'ready',
      error: null,
    });
    log(`[wire-stage] ${sourceKey}/${clipId} → ${r2Key}`);
    const formatted = formatStagedClip(row);
    await attachPlaybackUrl(formatted, row);
    return { ok: true, cached: false, ...formatted };
  } finally {
    cleanupDir(tmpDir);
  }
}

module.exports = { stageWireStoryToR2, wireClipId };
