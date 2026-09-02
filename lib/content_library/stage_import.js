'use strict';

/**
 * Stage local MP4 or remote URL (YouTube / Facebook / etc.) into library-staging
 * for Compose — no channel roster required.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');
const { execFile } = require('child_process');
const { uploadToR2, isR2Configured } = require('../storage');
const { downloadWithYtdlp } = require('./media_download');
const { extractClipIdFromUrl } = require('./clip_ids');
const { stagingExpiresAtMs } = require('./time_et');
const {
  getStagedClipByUrl,
  upsertStagedClip,
  formatStagedClip,
} = require('./staged_store');
const { attachPlaybackUrl } = require('./playback_url');

const DEFAULT_MAX_DURATION_SEC = 900; // 15 min full-pull cap
const REPO_ROOT = path.join(__dirname, '..', '..');

function stagingFolder() {
  return process.env.R2_LIBRARY_FOLDER || 'library-staging';
}

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function detectPlatform(url) {
  const u = String(url || '');
  if (/facebook\.com|fb\.watch/i.test(u)) return 'facebook';
  if (/youtube\.com|youtu\.be/i.test(u)) return 'youtube';
  if (/twitch\.tv/i.test(u)) return 'twitch';
  if (/kick\.com/i.test(u)) return 'kick';
  return 'import';
}

function sanitizeStreamer(s, fallback) {
  const out = String(s || fallback || 'import')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 40);
  return out || 'import';
}

function stableClipId(seed) {
  const h = nodeCrypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 16);
  return `imp_${h}`;
}

function probeDurationSec(filePath) {
  return execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], { timeout: 30000 }).then((out) => {
    const n = parseFloat(out);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  }).catch(() => 0);
}

async function probeRemoteDurationSec(url) {
  const ytdlp = process.env.YTDLP_PATH || 'yt-dlp';
  try {
    const out = await execFileAsync(ytdlp, [
      '--print', '%(duration)s',
      '--no-playlist',
      '--no-warnings',
      url,
    ], { timeout: 60000 });
    const n = parseFloat(String(out).split('\n')[0]);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  } catch (_) {
    return 0;
  }
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

async function upsertAndAttach({
  platform,
  streamer,
  clipId,
  url,
  title,
  durationSec,
  localPath,
  force,
  log,
}) {
  if (!isR2Configured()) {
    throw new Error('R2 not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  }
  if (!force) {
    const existing = getStagedClipByUrl(url);
    if (existing?.status === 'ready' && existing.r2_url) {
      const expired = existing.expires_at && existing.expires_at < Date.now() && !existing.used_at;
      if (!expired) {
        const formatted = formatStagedClip(existing);
        return { ok: true, cached: true, ...(await attachPlaybackUrl(formatted, existing)) };
      }
    }
  }

  const size = fs.statSync(localPath).size;
  if (size < 5000) throw new Error('Import file too small');

  const r2Key = `${stagingFolder()}/${streamer}/${clipId}.mp4`;
  log(`[stage-import] uploading ${Math.round(size / 1024)}KB → ${r2Key}`);
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
    title: title || clipId,
    duration_sec: durationSec || 0,
    thumbnail_url: null,
    r2_key: r2Key,
    r2_url: r2Url,
    staged_at: Date.now(),
    expires_at: stagingExpiresAtMs(),
    status: 'ready',
    error: null,
  });
  const formatted = formatStagedClip(row);
  return { ok: true, cached: false, ...(await attachPlaybackUrl(formatted, row)) };
}

/**
 * Stage an on-disk MP4 (operator import / FB reel already downloaded).
 * @param {{ localPath: string, title?: string, streamer?: string, sourceUrl?: string, platform?: string, force?: boolean }} input
 */
async function stageLocalFile(input, { log = console.log, force = false } = {}) {
  const localPath = assertSafeLocalPath(input?.localPath || input?.path || '');
  const sourceUrl = input.sourceUrl || input.url || `local://${path.basename(localPath)}`;
  const platform = input.platform || (/facebook|fb_reel/i.test(sourceUrl + localPath) ? 'facebook' : 'local');
  const streamer = sanitizeStreamer(input.streamer, platform === 'facebook' ? 'fb_reel' : 'local_import');
  const clipId = input.clipId || stableClipId(sourceUrl + '|' + localPath);
  const durationSec = input.durationSec || await probeDurationSec(localPath);
  const title = input.title || path.basename(localPath, path.extname(localPath));

  return upsertAndAttach({
    platform,
    streamer,
    clipId,
    url: sourceUrl,
    title,
    durationSec,
    localPath,
    force: force || !!input.force,
    log,
  });
}

/**
 * Download a YouTube / Facebook / etc. URL via yt-dlp and stage for Compose.
 * Full-video pull capped by maxDurationSec unless startSec/endSec is set
 * (then delegates to stage-vod-window semantics via section download).
 */
async function stageRemoteUrl(input, { log = console.log, force = false } = {}) {
  const url = String(input?.url || input?.vodUrl || '').trim();
  if (!url) throw new Error('url required');
  if (!/^https?:\/\//i.test(url)) throw new Error('url must be http(s)');

  const platform = input.platform || detectPlatform(url);
  const streamer = sanitizeStreamer(input.streamer, platform === 'youtube' ? 'yt_paste' : platform);
  const parsedId = extractClipIdFromUrl(url);
  const clipId = input.clipId || (parsedId ? `imp_${parsedId}` : stableClipId(url));
  const maxDurationSec = Math.min(
    Math.max(30, Number(input.maxDurationSec) || DEFAULT_MAX_DURATION_SEC),
    1800,
  );

  const startSec = input.startSec != null ? Math.max(0, Math.floor(Number(input.startSec))) : null;
  const endSec = input.endSec != null ? Math.max(0, Math.floor(Number(input.endSec))) : null;
  const useWindow = startSec != null && endSec != null && endSec > startSec;

  if (!useWindow) {
    const remoteDur = await probeRemoteDurationSec(url);
    if (remoteDur > maxDurationSec) {
      const err = Object.assign(
        new Error(
          `Video is ${remoteDur}s (max full-pull ${maxDurationSec}s). Use “Paste URL → Peaks” or pass startSec/endSec.`,
        ),
        { code: 'TOO_LONG', durationSec: remoteDur, maxDurationSec },
      );
      throw err;
    }
  }

  if (!force) {
    const existing = getStagedClipByUrl(url);
    if (existing?.status === 'ready' && existing.r2_url) {
      const expired = existing.expires_at && existing.expires_at < Date.now() && !existing.used_at;
      if (!expired) {
        const formatted = formatStagedClip(existing);
        return { ok: true, cached: true, ...(await attachPlaybackUrl(formatted, existing)) };
      }
    }
  }

  // Long VOD window → existing peak stager (120s cap there)
  if (useWindow && (endSec - startSec) <= 120 && (platform === 'youtube' || platform === 'twitch')) {
    const { stageVodWindowToR2 } = require('./stage_vod_window');
    const out = await stageVodWindowToR2({
      vodUrl: url,
      startSec,
      endSec,
      streamer,
      title: input.title,
      platform,
      force: force || !!input.force,
    }, { log });
    const row = getStagedClipByUrl(out.url || url);
    return row ? { ok: true, ...(await attachPlaybackUrl(out, row)) } : { ok: true, ...out };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-import-'));
  const localPath = path.join(tmpDir, `${clipId}.mp4`);
  try {
    const timeoutMs = Math.max(180000, maxDurationSec * 1500);
    if (useWindow) {
      const ytdlp = process.env.YTDLP_PATH || 'yt-dlp';
      const section = `*${startSec}-${endSec}`;
      log(`[stage-import] yt-dlp section ${section} ← ${url.slice(0, 80)}`);
      await execFileAsync(ytdlp, [
        '--download-sections', section,
        '--force-keyframes-at-cuts',
        '--format', 'bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=720]/best',
        '--output', localPath,
        '--no-playlist',
        '--no-warnings',
        '--merge-output-format', 'mp4',
        url,
      ], { timeout: timeoutMs });
    } else {
      await downloadWithYtdlp(url, localPath, { log, timeoutMs });
    }
    // Resolve actual file — yt-dlp merge may write clipId.mp4 or clipId.*.mp4
    let resolvedPath = localPath;
    if (!fs.existsSync(resolvedPath) || fs.statSync(resolvedPath).size < 5000) {
      const found = fs.readdirSync(tmpDir)
        .filter((n) => n.startsWith(clipId) && /\.(mp4|mkv|webm|m4a)$/i.test(n))
        .map((n) => path.join(tmpDir, n))
        .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
      if (found) resolvedPath = found;
    }
    if (!fs.existsSync(resolvedPath) || fs.statSync(resolvedPath).size < 5000) {
      throw new Error('Download produced empty file');
    }
    const durationSec = await probeDurationSec(resolvedPath);
    const title = input.title || `${platform} import ${parsedId || clipId}`;
    // MUST await — finally deletes tmpDir; bare return raced upload → ENOENT / ECONNRESET
    return await upsertAndAttach({
      platform,
      streamer,
      clipId,
      url,
      title,
      durationSec,
      localPath: resolvedPath,
      force: true,
      log,
    });
  } finally {
    try {
      if (tmpDir && fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
  }
}

module.exports = {
  stageLocalFile,
  stageRemoteUrl,
  DEFAULT_MAX_DURATION_SEC,
  assertSafeLocalPath,
  detectPlatform,
};
