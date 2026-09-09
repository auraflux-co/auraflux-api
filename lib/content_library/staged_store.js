'use strict';

const { query: dbQuery } = require('../db/postgres');
const { extractClipIdFromUrl } = require('./clip_ids');

async function getStagedClipByUrl(url) {
  if (!url) return null;
  const id = extractClipIdFromUrl(url);
  if (id) {
    const byId = await dbQuery(
      'SELECT * FROM library_staged_clips WHERE clip_id = $1 LIMIT 1',
      [id],
    );
    if (byId.rows[0]) return byId.rows[0];
  }
  const byUrl = await dbQuery(
    'SELECT * FROM library_staged_clips WHERE url = $1 LIMIT 1',
    [url],
  );
  return byUrl.rows[0] || null;
}

async function getStagedClipByPlatformId(platform, clipId) {
  if (!platform || !clipId) return null;
  const result = await dbQuery(
    'SELECT * FROM library_staged_clips WHERE platform = $1 AND clip_id = $2 LIMIT 1',
    [platform, clipId],
  );
  return result.rows[0] || null;
}

async function upsertStagedClip(row) {
  const now = Date.now();
  await dbQuery(
    `INSERT INTO library_staged_clips
       (platform, streamer, clip_id, url, title, duration_sec, thumbnail_url,
        r2_key, r2_url, staged_at, used_at, job_id, expires_at, status, error, brand_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (platform, clip_id) DO UPDATE SET
       url = EXCLUDED.url,
       title = COALESCE(EXCLUDED.title, library_staged_clips.title),
       duration_sec = COALESCE(EXCLUDED.duration_sec, library_staged_clips.duration_sec),
       thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, library_staged_clips.thumbnail_url),
       r2_key = EXCLUDED.r2_key,
       r2_url = EXCLUDED.r2_url,
       staged_at = EXCLUDED.staged_at,
       status = EXCLUDED.status,
       error = EXCLUDED.error,
       brand_id = COALESCE(EXCLUDED.brand_id, library_staged_clips.brand_id),
       expires_at = CASE
         WHEN library_staged_clips.used_at IS NOT NULL THEN library_staged_clips.expires_at
         ELSE EXCLUDED.expires_at
       END`,
    [
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
      row.brand_id || null,
    ],
  );
  return getStagedClipByPlatformId(row.platform, row.clip_id);
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
    stagedAt: row.staged_at ? new Date(Number(row.staged_at)).toISOString() : null,
    used: !!row.used_at,
    jobId: row.job_id,
    expiresAt: row.expires_at ? new Date(Number(row.expires_at)).toISOString() : null,
    status: row.status,
    error: row.error,
  };
}

module.exports = {
  getStagedClipByUrl,
  getStagedClipByPlatformId,
  upsertStagedClip,
  formatStagedClip,
};
