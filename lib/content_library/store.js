'use strict';
/**
 * Postgres-backed VOD peak sessions/segments (customer Peaks MVP).
 */

const { query: dbQuery } = require('../db/postgres');

async function upsertVodSession(row) {
  const result = await dbQuery(
    `INSERT INTO library_vod_sessions
       (platform, streamer, vod_id, url, title, duration_sec, views, status, brand_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (platform, vod_id) DO UPDATE SET
       title = EXCLUDED.title,
       duration_sec = EXCLUDED.duration_sec,
       views = EXCLUDED.views,
       url = EXCLUDED.url,
       streamer = EXCLUDED.streamer,
       brand_id = COALESCE(EXCLUDED.brand_id, library_vod_sessions.brand_id),
       status = EXCLUDED.status
     RETURNING id`,
    [
      row.platform,
      row.streamer || 'unknown',
      row.vod_id,
      row.url || null,
      row.title || null,
      row.duration_sec || 0,
      row.views || 0,
      row.status || 'pending',
      row.brand_id || null,
    ],
  );
  return result.rows[0]?.id;
}

async function saveVodSegments(sessionId, segments) {
  await dbQuery('DELETE FROM library_vod_segments WHERE session_id = $1', [sessionId]);
  for (const s of segments || []) {
    await dbQuery(
      `INSERT INTO library_vod_segments
         (session_id, start_sec, end_sec, score, title, summary)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        sessionId,
        s.start_sec,
        s.end_sec,
        s.score ?? null,
        s.title || null,
        s.summary || null,
      ],
    );
  }
}

async function getVodSegments(sessionId) {
  const result = await dbQuery(
    `SELECT id, session_id, start_sec, end_sec, score, title, summary, created_at
       FROM library_vod_segments
      WHERE session_id = $1
      ORDER BY score DESC NULLS LAST, start_sec ASC`,
    [sessionId],
  );
  return result.rows || [];
}

module.exports = {
  upsertVodSession,
  saveVodSegments,
  getVodSegments,
};
