'use strict';
/**
 * Sidebar thumbnail manifest + approval for Twitch Soup chrome.
 * Uses Twitch landscape thumbs from orderedClipUrls; operator approves before assembly burn.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { execFile } = require('child_process');
const { ffmpegPath } = require('./ffmpeg_utils');

const THUMB_W = 120;
const THUMB_H = 68;

function thumbCacheDir(jobId) {
  const dir = path.join(__dirname, '..', 'tmp', 'sidebar_thumbs', jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function streamerKey(streamer, idx) {
  return String(
    streamer?.twitchUsername
    || streamer?.username
    || streamer?.displayName
    || `streamer_${idx}`
  ).toLowerCase().replace(/[^a-z0-9_]+/g, '_');
}

function findClipForStreamer(clips, streamer, idx) {
  const name = String(streamer?.displayName || streamer?.twitchUsername || '').toLowerCase();
  const user = String(streamer?.twitchUsername || streamer?.username || '').toLowerCase();
  const byName = clips.find((c) => {
    const dn = String(c.displayName || c.streamer || '').toLowerCase();
    const su = String(c.streamer || '').toLowerCase();
    return (name && dn === name) || (user && (su === user || dn === user));
  });
  return byName || clips[idx] || null;
}

/**
 * Build manifest rows for dashboard preview + assembly.
 */
function buildThumbnailManifest(card) {
  const streamers = card?.streamers || [];
  const clips = card?.orderedClipUrls || [];
  const saved = card?.sidebarThumbs || {};

  return streamers.map((streamer, idx) => {
    const key = streamerKey(streamer, idx);
    const clip = findClipForStreamer(clips, streamer, idx);
    const imageUrl = saved[key]?.overrideUrl
      || clip?.thumbnailUrl
      || clip?.imageUrl
      || streamer?.thumbnailUrl
      || null;
    const entry = saved[key] || {};
    return {
      key,
      displayName: streamer.displayName || streamer.twitchUsername || key,
      imageUrl,
      approved: entry.approved === true,
      rejected: entry.rejected === true,
      overrideUrl: entry.overrideUrl || null,
      localPath: entry.localPath || null,
      previewOk: entry.previewOk !== false,
    };
  });
}

function allThumbnailsApproved(manifest) {
  if (!manifest || !manifest.length) return false;
  return manifest.every((row) => {
    if (row.rejected) return false;
    if (!row.approved) return false;
    return !!(row.localPath && fs.existsSync(row.localPath));
  });
}

function applyThumbApproval(card, { key, approved, rejected, overrideUrl }) {
  const next = { ...(card.sidebarThumbs || {}) };
  const prev = next[key] || {};
  next[key] = {
    ...prev,
    approved: approved === true,
    rejected: rejected === true,
    overrideUrl: overrideUrl != null ? String(overrideUrl).trim() || null : prev.overrideUrl,
  };
  if (rejected === true) next[key].approved = false;
  return { ...card, sidebarThumbs: next };
}

async function downloadAndScaleThumb(imageUrl, outPath) {
  if (!imageUrl) throw new Error('No image URL');
  const resp = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'User-Agent': 'AuraFlux/1.0' },
    validateStatus: (s) => s >= 200 && s < 400,
  });
  const rawPath = outPath.replace(/\.jpg$/i, '_raw.jpg');
  fs.writeFileSync(rawPath, Buffer.from(resp.data));
  await new Promise((res, rej) => {
    execFile(ffmpegPath(), [
      '-i', rawPath,
      '-vf', `scale=${THUMB_W}:${THUMB_H}:force_original_aspect_ratio=increase,crop=${THUMB_W}:${THUMB_H}`,
      '-frames:v', '1',
      '-y', outPath,
    ], { timeout: 60000 }, (err) => (err ? rej(err) : res()));
  });
  try { fs.unlinkSync(rawPath); } catch {}
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 200) {
    throw new Error('Scaled thumb missing or too small');
  }
  return outPath;
}

/**
 * Sync manifest: download approved-scale thumbs into tmp cache; update card.sidebarThumbs.
 */
async function syncThumbnailCache(jobId, card) {
  const manifest = buildThumbnailManifest(card);
  const dir = thumbCacheDir(jobId);
  const sidebarThumbs = { ...(card.sidebarThumbs || {}) };
  const results = [];

  for (const row of manifest) {
    const url = row.overrideUrl || row.imageUrl;
    const outPath = path.join(dir, `${row.key}.jpg`);
    let previewOk = true;
    let localPath = sidebarThumbs[row.key]?.localPath || null;

    if (!url) {
      previewOk = false;
      results.push({ ...row, previewOk, error: 'No thumbnail URL' });
      continue;
    }

    try {
      await downloadAndScaleThumb(url, outPath);
      localPath = outPath;
      previewOk = true;
    } catch (e) {
      previewOk = false;
      localPath = null;
      results.push({ ...row, previewOk, error: e.message });
      continue;
    }

    sidebarThumbs[row.key] = {
      ...(sidebarThumbs[row.key] || {}),
      localPath,
      previewOk,
      imageUrl: url,
    };
    results.push({ ...row, localPath, previewOk });
  }

  return {
    card: { ...card, sidebarThumbs },
    manifest: buildThumbnailManifest({ ...card, sidebarThumbs }),
    results,
  };
}

/** Map streamer index → local thumb path for chrome burn (approved only). */
function getThumbPathForStreamerIndex(card, idx) {
  const manifest = buildThumbnailManifest(card);
  const row = manifest[idx];
  if (!row || !row.approved || row.rejected) return null;
  const p = row.localPath || card?.sidebarThumbs?.[row.key]?.localPath;
  return p && fs.existsSync(p) ? p : null;
}

module.exports = {
  THUMB_W,
  THUMB_H,
  buildThumbnailManifest,
  allThumbnailsApproved,
  applyThumbApproval,
  syncThumbnailCache,
  getThumbPathForStreamerIndex,
  streamerKey,
};
