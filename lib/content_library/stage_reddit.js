'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { uploadToR2, isR2Configured } = require('../storage');
const { downloadRedditMedia, probeDuration } = require('../sources/reddit_source');
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

/**
 * Stage a Reddit post video to R2 for Library-style browser preview.
 * Idempotent — returns cached row when still valid.
 */
async function stageRedditPostToR2(input, { log = console.log, force = false } = {}) {
  const postId = String(input?.postId || input?.id || '').trim();
  const videoUrl = input?.videoUrl || input?.url || '';
  if (!postId) throw new Error('postId required');
  if (!videoUrl) throw new Error('videoUrl required');
  if (!isR2Configured()) {
    throw new Error('R2 not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  }

  const subreddit = String(input.subreddit || 'reddit').toLowerCase().replace(/[^a-z0-9_]/g, '') || 'reddit';
  const canonicalUrl = input.permalink || input.link || input.redditPermalink || `reddit:${postId}`;

  if (!force) {
    const existing = getStagedClipByPlatformId('reddit', postId)
      || getStagedClipByUrl(canonicalUrl)
      || getStagedClipByUrl(videoUrl);
    if (existing?.status === 'ready' && existing.r2_url) {
      const expired = existing.expires_at && existing.expires_at < Date.now() && !existing.used_at;
      if (!expired) {
        const formatted = formatStagedClip(existing);
        await attachPlaybackUrl(formatted, existing);
        return { ok: true, cached: true, ...formatted };
      }
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reddit-stage-'));
  const localPath = path.join(tmpDir, `${postId}.mp4`);
  try {
    log(`[reddit-stage] downloading ${videoUrl.slice(0, 80)}…`);
    await downloadRedditMedia(videoUrl, localPath, { maxSecs: 0 });
    const durationSec = await probeDuration(localPath);
    const r2Key = `${stagingFolder()}/reddit/${subreddit}/${postId}.mp4`;
    const r2Url = await uploadToR2(localPath, `${postId}.mp4`, {
      key: r2Key,
      contentType: 'video/mp4',
      cacheControl: 'public, max-age=604800',
    });
    const row = upsertStagedClip({
      platform: 'reddit',
      streamer: subreddit,
      clip_id: postId,
      url: canonicalUrl,
      title: input.title || null,
      duration_sec: durationSec || 0,
      thumbnail_url: input.thumbnailUrl || input.thumbnail || null,
      r2_key: r2Key,
      r2_url: r2Url,
      staged_at: Date.now(),
      expires_at: stagingExpiresAtMs(),
      status: 'ready',
      error: null,
    });
    log(`[reddit-stage] r/${subreddit}/${postId} → ${r2Key}`);
    const formatted = formatStagedClip(row);
    await attachPlaybackUrl(formatted, row);
    return { ok: true, cached: false, ...formatted };
  } finally {
    cleanupDir(tmpDir);
  }
}

module.exports = { stageRedditPostToR2 };
