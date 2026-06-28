'use strict';

const { getDb } = require('../db');
const { extractClipIdFromUrl } = require('./clip_ids');

function getStagedClipByUrl(url) {
  if (!url) return null;
  const db = getDb();
  const id = extractClipIdFromUrl(url);
  if (id) {
    const row = db.prepare('SELECT * FROM library_staged_clips WHERE clip_id = ?').get(id);
    if (row) return row;
  }
  return db.prepare('SELECT * FROM library_staged_clips WHERE url = ?').get(url) || null;
}

function getStagedClipByPlatformId(platform, clipId) {
  if (!platform || !clipId) return null;
  const db = getDb();
  return db.prepare('SELECT * FROM library_staged_clips WHERE platform = ? AND clip_id = ?').get(platform, clipId) || null;
}

function upsertStagedClip(row) {
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO library_staged_clips (
      platform, streamer, clip_id, url, title, duration_sec, thumbnail_url,
      r2_key, r2_url, staged_at, used_at, job_id, expires_at, status, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, clip_id) DO UPDATE SET
      url = excluded.url,
      title = COALESCE(excluded.title, title),
      duration_sec = COALESCE(excluded.duration_sec, duration_sec),
      thumbnail_url = COALESCE(excluded.thumbnail_url, thumbnail_url),
      r2_key = excluded.r2_key,
      r2_url = excluded.r2_url,
      staged_at = excluded.staged_at,
      status = excluded.status,
      error = excluded.error,
      expires_at = CASE WHEN library_staged_clips.used_at IS NOT NULL THEN library_staged_clips.expires_at ELSE excluded.expires_at END
  `);
  stmt.run(
    row.platform,
    row.streamer,
    row.clip_id,
    row.url,
    row.title || null,
    row.duration_sec || 0,
    row.thumbnail_url || null,
    row.r2_key,
    row.r2_url,
    row.staged_at || now,
    row.used_at || null,
    row.job_id || null,
    row.expires_at,
    row.status || 'ready',
    row.error || null,
  );
  return getStagedClipByUrl(row.url);
}

function markStagedClipsUsedForJob(jobId, clipUrls = []) {
  if (!jobId || !clipUrls.length) return 0;
  const db = getDb();
  const now = Date.now();
  let updated = 0;
  const stmt = db.prepare(`
    UPDATE library_staged_clips
    SET used_at = ?, job_id = ?
    WHERE (url = ? OR clip_id = ?) AND status = 'ready'
  `);
  for (const url of clipUrls) {
    if (!url) continue;
    const id = extractClipIdFromUrl(url);
    updated += stmt.run(now, jobId, url, id || url).changes;
  }
  return updated;
}

function listStagedClipsEligibleForPurge(now = Date.now()) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM library_staged_clips
    WHERE used_at IS NULL AND job_id IS NULL
      AND expires_at IS NOT NULL AND expires_at < ?
      AND status = 'ready' AND r2_key IS NOT NULL
  `).all(now);
}

/** Used staging retained 7d after EXECUTE, then R2 object removed. */
function listUsedStagedClipsEligibleForPurge(now = Date.now(), retainMs = 7 * 86400000) {
  const db = getDb();
  const cutoff = now - retainMs;
  return db.prepare(`
    SELECT * FROM library_staged_clips
    WHERE used_at IS NOT NULL AND used_at < ?
      AND status = 'ready' AND r2_key IS NOT NULL
  `).all(cutoff);
}

function deleteStagedClipRow(id) {
  const db = getDb();
  return db.prepare('DELETE FROM library_staged_clips WHERE id = ?').run(id).changes;
}

function formatStagedClip(row) {
  if (!row) return null;
  return {
    platform: row.platform,
    streamer: row.streamer,
    clipId: row.clip_id,
    url: row.url,
    title: row.title,
    duration: row.duration_sec,
    thumbnailUrl: row.thumbnail_url,
    r2Key: row.r2_key,
    r2Url: row.r2_url,
    stagedUrl: row.r2_url,
    mp4Url: row.r2_url,
    stagedAt: row.staged_at ? new Date(row.staged_at).toISOString() : null,
    used: !!row.used_at,
    jobId: row.job_id,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    status: row.status,
    error: row.error,
  };
}

function listUsedStagedStoryIds() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT platform, clip_id, url FROM library_staged_clips WHERE used_at IS NOT NULL
  `).all();
  const clipIds = [];
  const urls = [];
  rows.forEach((r) => {
    if (r.clip_id) clipIds.push(`${r.platform}:${r.clip_id}`);
    if (r.url) urls.push(r.url);
  });
  return { clipIds, urls };
}

module.exports = {
  getStagedClipByUrl,
  getStagedClipByPlatformId,
  upsertStagedClip,
  markStagedClipsUsedForJob,
  listStagedClipsEligibleForPurge,
  listUsedStagedClipsEligibleForPurge,
  deleteStagedClipRow,
  formatStagedClip,
  listUsedStagedStoryIds,
};
