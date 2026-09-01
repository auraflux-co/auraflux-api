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
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
      const platformsRaw = String(req.query.platforms || 'twitch,kick,youtube');
      const platforms = platformsRaw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
      // CPD-1288 — honor Clip Library Last 7D / 30D pills (was ignored before)
      const window = String(req.query.window || req.query.pubWindow || 'last7d').trim() || 'last7d';
      const results = await fetchStreamerPickerVods({
        streamers,
        platforms: platforms.length ? platforms : ['twitch', 'kick', 'youtube'],
        limit,
        window,
      });
      res.json({ ok: true, window, streamers: results });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/content-library/vod/analyze', async (req, res) => {
    try {
      const { extractYoutubeVideoId, isYoutubeUrl } = require('./youtube_heatmap');
      const { streamer, vodUrl, vodId, title, durationSec, views, platform, targetSec, maxPeaks } = req.body || {};
      if (!vodUrl && !vodId) return res.status(400).json({ ok: false, error: 'vodUrl or vodId required' });
      const resolvedPlatform = platform
        || (isYoutubeUrl(vodUrl) ? 'youtube' : 'twitch');
      const url = vodUrl
        || (resolvedPlatform === 'youtube'
          ? `https://www.youtube.com/watch?v=${vodId}`
          : `https://www.twitch.tv/videos/${vodId}`);
      const id = vodId
        || (resolvedPlatform === 'youtube' ? extractYoutubeVideoId(url) : null)
        || (url.match(/videos\/(\d+)/)?.[1]);
      const out = await analyzeVodHighlights({
        platform: resolvedPlatform,
        streamer: streamer || 'unknown',
        vodUrl: url,
        vodId: id,
        title,
        durationSec,
        views,
        targetSec: targetSec != null ? Number(targetSec) : (resolvedPlatform === 'youtube' ? 45 : 420),
        maxPeaks: maxPeaks != null ? Number(maxPeaks) : 8,
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

  app.get('/content-library/used-clip-ids', (_req, res) => {
    try {
      const { listUsedClipIds } = require('./store');
      const { listUsedStagedStoryIds } = require('./staged_store');
      const twitch = listUsedClipIds();
      const staged = listUsedStagedStoryIds();
      res.json({
        ok: true,
        clipIds: [...(twitch.clipIds || []), ...(staged.clipIds || [])],
        urls: [...(twitch.urls || []), ...(staged.urls || [])],
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/content-library/analyze-url', async (req, res) => {
    try {
      const { analyzePasteUrl } = require('./paste_url_moments');
      const out = await analyzePasteUrl(req.body || {}, { log: console.log });
      res.json(out);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/content-library/stage-vod-window', async (req, res) => {
    try {
      const { stageVodWindowToR2 } = require('./stage_vod_window');
      const body = req.body || {};
      const out = await stageVodWindowToR2({
        vodUrl: body.vodUrl || body.url,
        vodId: body.vodId,
        startSec: body.startSec != null ? body.startSec : body.start_sec,
        endSec: body.endSec != null ? body.endSec : body.end_sec,
        streamer: body.streamer,
        title: body.title,
        platform: body.platform,
        thumbnailUrl: body.thumbnailUrl,
      }, { force: !!body.force });
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/content-library/stage', async (req, res) => {
    try {
      const { stageClipToR2, stageClipsBatch } = require('./stage_clip');
      const { getStagedClipByUrl } = require('./staged_store');
      const { attachPlaybackUrl } = require('./playback_url');
      const body = req.body || {};
      const clips = Array.isArray(body.clips) ? body.clips : (body.url ? [body] : []);
      if (!clips.length) {
        return res.status(400).json({ ok: false, error: 'clips array or url required' });
      }
      if (clips.length === 1) {
        const out = await stageClipToR2(clips[0], { force: !!body.force });
        const row = getStagedClipByUrl(clips[0].url);
        const staged = row ? await attachPlaybackUrl(out, row) : out;
        return res.json({ ok: true, clip: staged, staged });
      }
      const results = await stageClipsBatch(clips, { force: !!body.force });
      for (const r of results) {
        if (!r.ok) continue;
        const row = getStagedClipByUrl(r.url);
        if (row) await attachPlaybackUrl(r, row);
      }
      const okCount = results.filter((r) => r.ok).length;
      res.json({ ok: okCount > 0, results, staged: okCount, failed: results.length - okCount });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/content-library/staged', async (req, res) => {
    try {
      const url = req.query.url;
      if (!url) return res.status(400).json({ ok: false, error: 'url required' });
      const { getStagedClipByUrl, formatStagedClip } = require('./staged_store');
      const { attachPlaybackUrl } = require('./playback_url');
      const row = getStagedClipByUrl(url);
      if (!row || row.status !== 'ready') {
        return res.json({ ok: true, staged: false, clip: null });
      }
      const clip = await attachPlaybackUrl(formatStagedClip(row), row);
      res.json({ ok: true, staged: true, clip });
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
