'use strict';

/**
 * CPD-1270 — Stage a YouTube/Twitch VOD *window* (peak clip) to R2 for Composer preview.
 * Never downloads the full multi-hour VOD — uses yt-dlp --download-sections (same as post-live preview).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { uploadToR2, isR2Configured } = require('../storage');
const { extractClipIdFromUrl } = require('./clip_ids');
const { stagingExpiresAtMs } = require('./time_et');
const {
  getStagedClipByUrl,
  upsertStagedClip,
  formatStagedClip,
} = require('./staged_store');
const { extractPreviewWithYtdlp, getOrExtractPreviewMp4 } = require('../post_live/vod_preview');

function stagingFolder() {
  return process.env.R2_LIBRARY_FOLDER || 'library-staging';
}

function windowClipId(videoId, startSec, endSec) {
  const id = String(videoId || 'vod').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return `${id}_${Math.floor(startSec)}_${Math.floor(endSec)}`;
}

function windowPageUrl(vodUrl, startSec, endSec) {
  const base = String(vodUrl || '').split('#')[0];
  const join = base.includes('?') ? '&' : '?';
  return `${base}${join}cwn_win=${Math.floor(startSec)}-${Math.floor(endSec)}`;
}

/**
 * @param {object} input
 * @param {string} input.vodUrl
 * @param {number} input.startSec
 * @param {number} input.endSec
 * @param {string} [input.vodId]
 * @param {string} [input.streamer]
 * @param {string} [input.title]
 * @param {string} [input.platform]
 * @param {string} [input.thumbnailUrl]
 */
async function stageVodWindowToR2(input, { log = console.log, force = false } = {}) {
  const vodUrl = input?.vodUrl || input?.url || '';
  if (!vodUrl) throw new Error('vodUrl required');
  if (!isR2Configured()) {
    throw new Error('R2 not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  }

  const startSec = Math.max(0, Math.floor(Number(input.startSec != null ? input.startSec : input.start_sec) || 0));
  let endSec = Math.floor(Number(input.endSec != null ? input.endSec : input.end_sec) || (startSec + 45));
  if (endSec <= startSec) endSec = startSec + 45;
  if (endSec - startSec > 120) {
    endSec = startSec + 120;
  }

  const platform = input.platform || (/youtube\.com|youtu\.be/i.test(vodUrl) ? 'youtube' : 'twitch');
  const streamer = String(input.streamer || 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'unknown';
  const videoId = input.vodId || extractClipIdFromUrl(vodUrl) || 'vod';
  const clipId = windowClipId(videoId, startSec, endSec);
  const pageUrl = windowPageUrl(vodUrl, startSec, endSec);

  if (!force) {
    const existing = getStagedClipByUrl(pageUrl);
    if (existing?.status === 'ready' && existing.r2_url) {
      const expired = existing.expires_at && existing.expires_at < Date.now() && !existing.used_at;
      if (!expired) {
        return { ok: true, cached: true, startSec, endSec, ...formatStagedClip(existing) };
      }
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vod-win-stage-'));
  const localPath = path.join(tmpDir, `${clipId}.mp4`);
  const jobId = `lib_vodwin_${clipId}`;

  try {
    // Bust local preview cache when force-restaging so format upgrades apply
    if (force) {
      try {
        const { previewFilePath } = require('../post_live/vod_preview');
        const cachedPreview = previewFilePath(clipId, startSec, endSec);
        if (fs.existsSync(cachedPreview)) fs.unlinkSync(cachedPreview);
      } catch (_) { /* ignore */ }
    }
    try {
      await extractPreviewWithYtdlp({
        vodUrl,
        dest: localPath,
        startS: startSec,
        endS: endSec,
        jobId,
      });
    } catch (ytdlpErr) {
      log(`[vod-window-stage] yt-dlp sections failed (${ytdlpErr.message}) — getOrExtractPreviewMp4 fallback`);
      const extracted = await getOrExtractPreviewMp4({
        videoId: clipId,
        vodUrl,
        start_s: startSec,
        end_s: endSec,
      });
      const src = path.join(require('../post_live/vod_preview').TMP_DIR, extracted.filename);
      if (!fs.existsSync(src)) throw new Error('VOD window extract failed');
      fs.copyFileSync(src, localPath);
    }

    if (!fs.existsSync(localPath) || fs.statSync(localPath).size < 10000) {
      throw new Error('VOD window file too small / missing');
    }

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
      url: pageUrl,
      title: input.title || `VOD window ${startSec}-${endSec}`,
      duration_sec: endSec - startSec,
      thumbnail_url: input.thumbnailUrl || input.thumbnail_url || null,
      r2_key: r2Key,
      r2_url: r2Url,
      staged_at: Date.now(),
      expires_at: stagingExpiresAtMs(),
      status: 'ready',
      error: null,
    });

    log(`[vod-window-stage] ${streamer}/${clipId} → ${r2Key} (${Math.round(fs.statSync(localPath).size / 1024)}KB)`);
    return {
      ok: true,
      cached: false,
      startSec,
      endSec,
      vodUrl,
      ...formatStagedClip(row),
    };
  } finally {
    try {
      if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
  }
}

module.exports = {
  stageVodWindowToR2,
  windowClipId,
  windowPageUrl,
};
