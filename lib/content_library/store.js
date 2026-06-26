'use strict';

const { getDb } = require('../db');
const { RETENTION_DAYS } = require('./index');

function upsertLibraryClip(row) {
  const db = getDb();
  const now = Date.now();
  const expiresAt = row.used_at ? null : (row.expires_at || now + RETENTION_DAYS * 86400000);
  const stmt = db.prepare(`
    INSERT INTO library_clips (
      platform, streamer, clip_id, url, title, views, duration_sec, thumbnail_url,
      clip_created_at, fetched_at, ingest_date, used_at, job_id, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, clip_id) DO UPDATE SET
      url = excluded.url,
      title = excluded.title,
      views = excluded.views,
      duration_sec = excluded.duration_sec,
      thumbnail_url = excluded.thumbnail_url,
      clip_created_at = excluded.clip_created_at,
      fetched_at = excluded.fetched_at,
      ingest_date = COALESCE(excluded.ingest_date, ingest_date),
      expires_at = CASE WHEN library_clips.used_at IS NOT NULL THEN NULL ELSE excluded.expires_at END
  `);
  const info = stmt.run(
    row.platform,
    row.streamer,
    row.clip_id,
    row.url,
    row.title || null,
    row.views || 0,
    row.duration_sec || 0,
    row.thumbnail_url || null,
    row.clip_created_at || null,
    row.fetched_at || now,
    row.ingest_date || null,
    row.used_at || null,
    row.job_id || null,
    expiresAt,
  );
  return info.changes;
}

function listLibraryClips({
  streamers = [],
  window = 'all',
  sort = 'views',
  limit = 200,
  offset = 0,
  unusedOnly = false,
} = {}) {
  const db = getDb();
  const { windowToSinceMs } = require('./time_et');
  const sinceMs = windowToSinceMs(window);
  const clauses = ['1=1'];
  const params = [];
  if (streamers.length) {
    clauses.push(`streamer IN (${streamers.map(() => '?').join(', ')})`);
    params.push(...streamers.map((s) => String(s).toLowerCase()));
  }
  if (sinceMs != null) {
    clauses.push('clip_created_at >= ?');
    params.push(sinceMs);
  }
  if (unusedOnly) {
    clauses.push('used_at IS NULL');
  }
  const order = sort === 'recent' ? 'clip_created_at DESC' : 'views DESC, clip_created_at DESC';
  const sql = `
    SELECT * FROM library_clips
    WHERE ${clauses.join(' AND ')}
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `;
  params.push(Math.min(Math.max(limit, 1), 500), Math.max(offset, 0));
  return db.prepare(sql).all(...params);
}

function countEligibleForPurge(now = Date.now()) {
  const db = getDb();
  return db.prepare(`
    SELECT COUNT(*) AS n FROM library_clips
    WHERE used_at IS NULL AND job_id IS NULL
      AND expires_at IS NOT NULL AND expires_at < ?
  `).get(now).n;
}

function purgeEligibleClips(now = Date.now(), { dryRun = false } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, streamer, clip_id, thumbnail_url FROM library_clips
    WHERE used_at IS NULL AND job_id IS NULL
      AND expires_at IS NOT NULL AND expires_at < ?
  `).all(now);
  if (dryRun) return { deleted: 0, wouldDelete: rows.length, rows };
  const del = db.prepare('DELETE FROM library_clips WHERE id = ?');
  let deleted = 0;
  for (const r of rows) {
    del.run(r.id);
    deleted += 1;
  }
  return { deleted, wouldDelete: rows.length, rows };
}

function markClipsUsedForJob(jobId, clipUrls = []) {
  if (!jobId || !clipUrls.length) return 0;
  const db = getDb();
  const now = Date.now();
  const { extractClipIdFromUrl } = require('./clip_ids');
  let updated = 0;
  const stmt = db.prepare(`
    UPDATE library_clips
    SET used_at = ?, job_id = ?, expires_at = NULL
    WHERE url = ? OR clip_id = ?
  `);
  for (const url of clipUrls) {
    if (!url) continue;
    const id = extractClipIdFromUrl(url);
    const info = stmt.run(now, jobId, url, id || url);
    updated += info.changes;
  }
  return updated;
}

function startIngestRun(ingestDate) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO library_ingest_runs (ingest_date, started_at, status)
    VALUES (?, ?, 'running')
  `).run(ingestDate, Date.now());
  return info.lastInsertRowid;
}

function finishIngestRun(runId, summary) {
  const db = getDb();
  db.prepare(`
    UPDATE library_ingest_runs SET
      completed_at = ?, streamers = ?, clips_added = ?, clips_updated = ?,
      errors = ?, status = ?, detail_json = ?
    WHERE id = ?
  `).run(
    Date.now(),
    summary.streamers || 0,
    summary.clipsAdded || 0,
    summary.clipsUpdated || 0,
    summary.errors || 0,
    summary.status || 'done',
    summary.detail ? JSON.stringify(summary.detail) : null,
    runId,
  );
}

function upsertVodSession(row) {
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO library_vod_sessions (
      platform, streamer, vod_id, url, title, duration_sec, views, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, vod_id) DO UPDATE SET
      title = excluded.title,
      duration_sec = excluded.duration_sec,
      views = excluded.views,
      url = excluded.url
  `).run(
    row.platform,
    row.streamer,
    row.vod_id,
    row.url,
    row.title || null,
    row.duration_sec || 0,
    row.views || 0,
    row.status || 'pending',
    now,
  );
  return db.prepare('SELECT id FROM library_vod_sessions WHERE platform = ? AND vod_id = ?')
    .get(row.platform, row.vod_id)?.id;
}

function saveVodSegments(sessionId, segments) {
  const db = getDb();
  const now = Date.now();
  db.prepare('DELETE FROM library_vod_segments WHERE session_id = ?').run(sessionId);
  const ins = db.prepare(`
    INSERT INTO library_vod_segments (session_id, start_sec, end_sec, score, title, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of segments) {
    ins.run(sessionId, s.start_sec, s.end_sec, s.score ?? null, s.title || null, s.summary || null, now);
  }
}

function getVodSegments(sessionId) {
  const db = getDb();
  return db.prepare('SELECT * FROM library_vod_segments WHERE session_id = ? ORDER BY score DESC').all(sessionId);
}

function listUsedClipIds() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT clip_id, url FROM library_clips WHERE used_at IS NOT NULL
  `).all();
  return {
    clipIds: rows.map((r) => r.clip_id).filter(Boolean),
    urls: rows.map((r) => r.url).filter(Boolean),
  };
}

module.exports = {
  upsertLibraryClip,
  listLibraryClips,
  countEligibleForPurge,
  purgeEligibleClips,
  markClipsUsedForJob,
  startIngestRun,
  finishIngestRun,
  upsertVodSession,
  saveVodSegments,
  getVodSegments,
  listUsedClipIds,
};
