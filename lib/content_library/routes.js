'use strict';

function registerContentLibraryRoutes(app) {
  const { listLibraryClips } = require('./store');
  const { runClipIngest } = require('./ingest_clips');
  const { runPurge } = require('./purge');
  const { loadRoster } = require('./index');
  const { analyzeVodHighlights, getVodSegments } = require('./vod_highlights');
  const { fetchStreamerPickerVods } = require('../pickers/streamers/vods');

  app.get('/content-library/clips', (req, res) => {
    try {
      const streamers = (req.query.streamers || '')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const window = req.query.window || '7d';
      const sort = req.query.sort || 'views';
      const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
      const clips = listLibraryClips({ streamers, window, sort, limit });
      res.json({
        ok: true,
        count: clips.length,
        window,
        clips: clips.map(formatLibraryClip),
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/content-library/roster', (_req, res) => {
    try {
      res.json({ ok: true, streamers: loadRoster() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/content-library/ingest', async (req, res) => {
    try {
      const dryRun = req.query.dryRun === '1' || req.body?.dryRun;
      const ingestDate = req.body?.ingestDate || null;
      const summary = await runClipIngest({ dryRun, ingestDate });
      res.json({ ok: true, summary });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/content-library/purge', async (req, res) => {
    try {
      const dryRun = req.query.dryRun === '1' || req.body?.dryRun;
      const result = await runPurge({ dryRun });
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/content-library/vods', async (req, res) => {
    try {
      const streamers = (req.query.streamers || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (!streamers.length) return res.status(400).json({ ok: false, error: 'streamers required' });
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
      const results = await fetchStreamerPickerVods({ streamers, platforms: ['twitch'], limit });
      res.json({ ok: true, streamers: results });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/content-library/vod/analyze', async (req, res) => {
    try {
      const { streamer, vodUrl, vodId, title, durationSec, views, platform } = req.body || {};
      if (!vodUrl && !vodId) return res.status(400).json({ ok: false, error: 'vodUrl or vodId required' });
      const url = vodUrl || `https://www.twitch.tv/videos/${vodId}`;
      const id = vodId || (url.match(/videos\/(\d+)/)?.[1]);
      const out = await analyzeVodHighlights({
        platform: platform || 'twitch',
        streamer: streamer || 'unknown',
        vodUrl: url,
        vodId: id,
        title,
        durationSec,
        views,
      });
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/content-library/vod/:sessionId/segments', (req, res) => {
    try {
      const segments = getVodSegments(Number(req.params.sessionId));
      res.json({ ok: true, segments });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

function formatLibraryClip(row) {
  return {
    id: row.id,
    platform: row.platform,
    streamer: row.streamer,
    clipId: row.clip_id,
    url: row.url,
    title: row.title,
    views: row.views,
    duration: row.duration_sec,
    thumbnailUrl: row.thumbnail_url,
    createdAt: row.clip_created_at ? new Date(row.clip_created_at).toISOString() : null,
    fetchedAt: row.fetched_at ? new Date(row.fetched_at).toISOString() : null,
    ingestDate: row.ingest_date,
    used: !!row.used_at,
    jobId: row.job_id,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
  };
}

module.exports = { registerContentLibraryRoutes };
