'use strict';
/**
 * CPD-1191 — Content Memory persistence (SQLite on C0).
 * Stores published video metadata, performance snapshots, and decision records.
 */

const { getDb } = require('../db');

function parseJson(raw, fallback = null) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function rowToVideo(row) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    platformVideoId: row.platform_video_id,
    jobId: row.job_id,
    channelId: row.channel_id,
    title: row.title,
    contentType: row.content_type,
    streamer: row.streamer,
    formFactor: row.form_factor,
    publishedAt: row.published_at,
    metadata: parseJson(row.metadata_json, {}),
    performance: parseJson(row.performance_json, {}),
    genome: parseJson(row.genome_json, {}),
    syncedAt: row.synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function upsertVideo(partial) {
  const db = getDb();
  const now = Date.now();
  const platform = partial.platform || 'youtube';
  const platformVideoId = partial.platformVideoId || partial.platform_video_id;
  if (!platformVideoId) throw new Error('platformVideoId required');

  const existing = db.prepare(
    'SELECT * FROM content_memory_videos WHERE platform = ? AND platform_video_id = ?'
  ).get(platform, platformVideoId);

  const metadata = partial.metadata != null
    ? partial.metadata
    : parseJson(existing?.metadata_json, {});
  const performance = partial.performance != null
    ? partial.performance
    : parseJson(existing?.performance_json, {});
  const genome = partial.genome != null
    ? partial.genome
    : parseJson(existing?.genome_json, {});

  db.prepare(`
    INSERT INTO content_memory_videos (
      platform, platform_video_id, job_id, channel_id, title, content_type,
      streamer, form_factor, published_at, metadata_json, performance_json,
      genome_json, synced_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, platform_video_id) DO UPDATE SET
      job_id = COALESCE(excluded.job_id, job_id),
      channel_id = COALESCE(excluded.channel_id, channel_id),
      title = COALESCE(excluded.title, title),
      content_type = COALESCE(excluded.content_type, content_type),
      streamer = COALESCE(excluded.streamer, streamer),
      form_factor = COALESCE(excluded.form_factor, form_factor),
      published_at = COALESCE(excluded.published_at, published_at),
      metadata_json = excluded.metadata_json,
      performance_json = excluded.performance_json,
      genome_json = excluded.genome_json,
      synced_at = COALESCE(excluded.synced_at, synced_at),
      updated_at = excluded.updated_at
  `).run(
    platform,
    platformVideoId,
    partial.jobId || partial.job_id || existing?.job_id || null,
    partial.channelId || partial.channel_id || existing?.channel_id || null,
    partial.title || existing?.title || null,
    partial.contentType || partial.content_type || existing?.content_type || null,
    partial.streamer || existing?.streamer || null,
    partial.formFactor || partial.form_factor || existing?.form_factor || null,
    partial.publishedAt || partial.published_at || existing?.published_at || now,
    JSON.stringify(metadata),
    JSON.stringify(performance),
    JSON.stringify(genome),
    partial.syncedAt || partial.synced_at || existing?.synced_at || null,
    existing?.created_at || now,
    now,
  );

  return getVideo(platform, platformVideoId);
}

function getVideo(platform, platformVideoId) {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM content_memory_videos WHERE platform = ? AND platform_video_id = ?'
  ).get(platform, platformVideoId);
  return rowToVideo(row);
}

function getVideoByJobId(jobId) {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM content_memory_videos WHERE job_id = ? ORDER BY updated_at DESC LIMIT 1'
  ).get(jobId);
  return rowToVideo(row);
}

function listVideos({ limit = 50, contentType, streamer, orderBy = 'updated_at' } = {}) {
  const db = getDb();
  const safeOrder = orderBy === 'published_at' ? 'published_at' : 'updated_at';
  const clauses = [];
  const params = [];
  if (contentType) {
    clauses.push('content_type = ?');
    params.push(contentType);
  }
  if (streamer) {
    clauses.push('streamer = ?');
    params.push(streamer);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = db.prepare(
    `SELECT * FROM content_memory_videos ${where} ORDER BY ${safeOrder} DESC LIMIT ?`
  ).all(...params, lim);
  return rows.map(rowToVideo);
}

function memoryStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) AS n FROM content_memory_videos').get()?.n || 0;
  const synced = db.prepare(
    'SELECT COUNT(*) AS n FROM content_memory_videos WHERE synced_at IS NOT NULL'
  ).get()?.n || 0;
  const decisions = db.prepare('SELECT COUNT(*) AS n FROM content_memory_decisions').get()?.n || 0;
  const byType = db.prepare(`
    SELECT content_type, COUNT(*) AS n FROM content_memory_videos
    WHERE content_type IS NOT NULL GROUP BY content_type ORDER BY n DESC LIMIT 10
  `).all();
  return { total, synced, pendingSync: total - synced, decisions, byContentType: byType };
}

function recordDecision({ jobId, kind, choice, reasons, outcome }) {
  if (!jobId || !kind) return null;
  const db = getDb();
  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO content_memory_decisions (job_id, kind, choice_json, reasons_json, outcome_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    jobId,
    kind,
    choice ? JSON.stringify(choice) : null,
    reasons ? JSON.stringify(reasons) : null,
    outcome ? JSON.stringify(outcome) : null,
    now,
  );
  return { id: info.lastInsertRowid, jobId, kind, createdAt: now };
}

function listDecisions(jobId, { limit = 20 } = {}) {
  const db = getDb();
  const lim = Math.max(1, Math.min(100, Number(limit) || 20));
  const rows = db.prepare(
    'SELECT * FROM content_memory_decisions WHERE job_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(jobId, lim);
  return rows.map((row) => ({
    id: row.id,
    jobId: row.job_id,
    kind: row.kind,
    choice: parseJson(row.choice_json, null),
    reasons: parseJson(row.reasons_json, null),
    outcome: parseJson(row.outcome_json, null),
    createdAt: row.created_at,
  }));
}

function updateDecisionOutcome(decisionId, outcome) {
  if (!decisionId || !outcome) return null;
  const db = getDb();
  db.prepare(
    'UPDATE content_memory_decisions SET outcome_json = ? WHERE id = ?'
  ).run(JSON.stringify(outcome), decisionId);
  return { id: decisionId, outcome };
}

function listPendingOutcomeDecisions({ limit = 100 } = {}) {
  const db = getDb();
  const lim = Math.max(1, Math.min(500, Number(limit) || 100));
  const rows = db.prepare(`
    SELECT * FROM content_memory_decisions
    WHERE outcome_json IS NULL
    ORDER BY created_at DESC
    LIMIT ?
  `).all(lim);
  return rows.map((row) => ({
    id: row.id,
    jobId: row.job_id,
    kind: row.kind,
    choice: parseJson(row.choice_json, null),
    reasons: parseJson(row.reasons_json, null),
    createdAt: row.created_at,
  }));
}

function topPerformers({ metric = 'views', contentType, streamer, limit = 10 } = {}) {
  const videos = listVideos({ limit: 200, contentType, streamer });
  const scored = videos
    .map((v) => {
      const perf = v.performance || {};
      const value = Number(perf[metric] ?? perf.views ?? 0);
      return { ...v, score: value };
    })
    .filter((v) => v.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
}

module.exports = {
  upsertVideo,
  getVideo,
  getVideoByJobId,
  listVideos,
  memoryStats,
  recordDecision,
  listDecisions,
  updateDecisionOutcome,
  listPendingOutcomeDecisions,
  topPerformers,
};
