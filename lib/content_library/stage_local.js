'use strict';
/**
 * Stage a customer-uploaded local MP4 into library-staging (Peaks browser hop).
 * Server receives multipart → R2 — no browser→R2 CORS, no YouTube download.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');
const { execFile } = require('child_process');
const { uploadToR2, isR2Configured } = require('../storage');
const { stagingExpiresAtMs } = require('./time_et');
const {
  getStagedClipByUrl,
  upsertStagedClip,
  formatStagedClip,
} = require('./staged_store');
const { attachPlaybackUrl } = require('./playback_url');

const REPO_ROOT = path.join(__dirname, '..', '..');

function stagingFolder() {
  return process.env.R2_LIBRARY_FOLDER || 'library-staging';
}

function sanitizeStreamer(s, fallback) {
  const out = String(s || fallback || 'local')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 40);
  return out || 'local';
}

function stableClipId(seed) {
  const h = nodeCrypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 16);
  return `imp_${h}`;
}

function probeDurationSec(filePath) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { timeout: 30000 },
      (err, stdout) => {
        if (err) return resolve(0);
        const n = parseFloat(String(stdout || '').trim());
        resolve(Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
      },
    );
  });
}

function assertSafeLocalPath(localPath) {
  const resolved = path.resolve(localPath);
  const allowedRoots = [
    path.join(REPO_ROOT, 'tmp'),
    path.join(REPO_ROOT, 'data', 'uploads'),
    path.join(REPO_ROOT, 'output'),
    os.tmpdir(),
  ].map((p) => path.resolve(p));
  const ok = allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!ok) {
    throw new Error('localPath must be under tmp/, data/uploads/, output/, or OS temp');
  }
  if (!fs.existsSync(resolved)) throw new Error('local file not found');
  return resolved;
}

/**
 * @param {{ localPath: string, title?: string, streamer?: string, sourceUrl?: string,
 *           platform?: string, clipId?: string, durationSec?: number, brandId?: string,
 *           startSec?: number, endSec?: number, force?: boolean }} input
 */
async function stageLocalFile(input, { log = console.log, force = false } = {}) {
  if (!isR2Configured()) {
    throw new Error('R2 not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  }

  const localPath = assertSafeLocalPath(input?.localPath || input?.path || '');
  const startSec = input.startSec != null ? Math.max(0, Math.floor(Number(input.startSec))) : null;
  const endSec = input.endSec != null ? Math.max(0, Math.floor(Number(input.endSec))) : null;
  const sourceUrl = input.sourceUrl || input.url
    || (startSec != null && endSec != null
      ? `local://peaks/${startSec}-${endSec}/${path.basename(localPath)}`
      : `local://${path.basename(localPath)}`);
  const platform = input.platform || 'local';
  const streamer = sanitizeStreamer(input.streamer, 'peaks_upload');
  const clipId = input.clipId
    || (startSec != null && endSec != null
      ? stableClipId(`${sourceUrl}|${startSec}|${endSec}|${path.basename(localPath)}`)
      : stableClipId(sourceUrl + '|' + localPath));

  if (!force) {
    const existing = await getStagedClipByUrl(sourceUrl);
    if (existing?.status === 'ready' && existing.r2_url) {
      const expired = existing.expires_at && existing.expires_at < Date.now() && !existing.used_at;
      if (!expired) {
        const formatted = formatStagedClip(existing);
        await attachPlaybackUrl(formatted, existing);
        return {
          ok: true,
          cached: true,
          startSec: startSec ?? undefined,
          endSec: endSec ?? undefined,
          ...formatted,
        };
      }
    }
  }

  const size = fs.statSync(localPath).size;
  if (size < 5000) throw new Error('Import file too small');

  const durationSec = input.durationSec
    || (startSec != null && endSec != null && endSec > startSec ? endSec - startSec : 0)
    || await probeDurationSec(localPath);
  const title = input.title || path.basename(localPath, path.extname(localPath));

  const r2Key = `${stagingFolder()}/${streamer}/${clipId}.mp4`;
  log(`[stage-local] uploading ${Math.round(size / 1024)}KB → ${r2Key}`);
  const r2Url = await uploadToR2(localPath, `${clipId}.mp4`, {
    key: r2Key,
    contentType: 'video/mp4',
    cacheControl: 'public, max-age=604800',
  });

  const row = await upsertStagedClip({
    platform,
    streamer,
    clip_id: clipId,
    url: sourceUrl,
    title,
    duration_sec: durationSec || 0,
    thumbnail_url: input.thumbnailUrl || input.thumbnail_url || null,
    r2_key: r2Key,
    r2_url: r2Url,
    staged_at: Date.now(),
    expires_at: stagingExpiresAtMs(),
    status: 'ready',
    error: null,
    brand_id: input.brandId || null,
  });

  const formatted = formatStagedClip(row);
  await attachPlaybackUrl(formatted, row);
  return {
    ok: true,
    cached: false,
    startSec: startSec ?? undefined,
    endSec: endSec ?? undefined,
    ...formatted,
  };
}

module.exports = {
  stageLocalFile,
  assertSafeLocalPath,
  probeDurationSec,
  stableClipId,
  sanitizeStreamer,
};
