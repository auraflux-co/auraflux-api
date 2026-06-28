'use strict';

const express = require('express');
const { buildChannelStatsReport } = require('../services/channel_stats');
const { parseClaimsCsv, claimsCsvTemplate } = require('../post_live/claims_csv');
const {
  importSessions,
  listSessions,
  getSession,
  patchSession,
  upsertSession,
} = require('../post_live/vod_sessions');
const { analyzeVodSession } = require('../post_live/vod_analyze');
const {
  registerSessionFromJob,
  isPublishedLongFormJob,
} = require('../post_live/register_from_job');
const {
  summarizePublishedJob,
  buildManualClipCandidate,
  mergeClipCandidates,
} = require('../post_live/repurpose');

const router = express.Router();
const analyzeJobs = new Map();

function inferStreamerFromTitle(title) {
  const t = String(title || '').toLowerCase();
  const names = [
    'plaqueboymax', 'jasontheween', 'stableronaldo', 'yourragegaming', 'cinna', 'marlon',
    'lacy', 'adapt', 'maya', 'extraemily', 'yonnajay', 'jaycinco', 'hasanabi', 'arky',
  ];
  for (const n of names) {
    if (t.includes(n)) return n;
  }
  const m = t.match(/^([a-z0-9_]+)\s+live\b/);
  return m ? m[1] : null;
}

async function fetchLiveVods({ handle, refresh = false, limit = 40, category = 'Streaming' } = {}) {
  const report = await buildChannelStatsReport({
    handle: handle || process.env.YOUTUBE_CHANNEL_HANDLE || 'clipzworldnews',
    refresh: !!refresh,
  });
  const items = (report.catalog?.items || [])
    .filter((it) => {
      if (category && category !== 'all' && it.category !== category) return false;
      if (it.tab !== 'streams' && !it.wasLive) return false;
      return true;
    })
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 40)))
    .map((it) => ({
      videoId: it.id,
      title: it.title,
      url: it.url,
      durationSec: it.durationSec || null,
      published: it.published || null,
      views: it.views || 0,
      category: it.category,
      wasLive: !!it.wasLive,
      streamer: inferStreamerFromTitle(it.title),
    }));

  return {
    ok: true,
    handle: report.handle,
    fetchedAt: report.fetchedAt,
    stale: !!report.stale,
    count: items.length,
    vods: items,
  };
}

router.get('/post-live/vods', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const limit = parseInt(req.query.limit, 10) || 40;
    const category = req.query.category || 'Streaming';
    const data = await fetchLiveVods({ handle: req.query.handle, refresh, limit, category });
    res.json(data);
  } catch (e) {
    console.error('[post-live/vods]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/post-live/sessions', (req, res) => {
  res.json({ ok: true, sessions: listSessions() });
});

router.get('/post-live/published-jobs', (req, res) => {
  const jobs = global.persistedJobsRef || {};
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
  const items = Object.entries(jobs)
    .filter(([, card]) => isPublishedLongFormJob(card))
    .map(([jobId, card]) => summarizePublishedJob(jobId, card))
    .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))
    .slice(0, limit);
  res.json({ ok: true, count: items.length, jobs: items });
});

router.post('/post-live/sessions/register-from-job', (req, res) => {
  const jobId = req.body?.jobId;
  if (!jobId) return res.status(400).json({ ok: false, error: 'jobId required' });
  const card = (global.persistedJobsRef || {})[jobId];
  if (!card) return res.status(404).json({ ok: false, error: `Job not found: ${jobId}` });
  if (!isPublishedLongFormJob(card)) {
    return res.status(409).json({ ok: false, error: 'Job is not a published long-form episode' });
  }
  try {
    const result = registerSessionFromJob(jobId, card);
    res.json({
      ok: true,
      jobId,
      videoId: result.videoId,
      session: result.session,
      sceneCount: result.repurpose.candidates.length,
      targets: result.repurpose.targets,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/post-live/sessions/:videoId/manual-clips', (req, res) => {
  const { videoId } = req.params;
  const session = getSession(videoId);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

  const clipsIn = Array.isArray(req.body?.clips) ? req.body.clips : [req.body].filter(Boolean);
  if (!clipsIn.length) {
    return res.status(400).json({ ok: false, error: 'Provide clips: [{ start_s, end_s, title? }] or start_s/end_s in body' });
  }

  try {
    const built = clipsIn.map((c) => buildManualClipCandidate(c));
    const sceneCandidates = mergeClipCandidates(session.sceneCandidates, built);
    const updated = patchSession(videoId, {
      sceneCandidates,
      repurposeMode: session.repurposeMode || 'timestamp',
      analyzeStatus: sceneCandidates.length ? 'scene_ready' : session.analyzeStatus,
    });
    res.json({
      ok: true,
      videoId,
      added: built.length,
      sceneCount: sceneCandidates.length,
      session: updated,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get('/post-live/sessions/:videoId', (req, res) => {
  const session = getSession(req.params.videoId);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });
  res.json({ ok: true, session });
});

router.get('/post-live/claims/template.csv', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="post-live-claims-template.csv"');
  res.send(claimsCsvTemplate());
});

router.post('/post-live/claims/import', (req, res) => {
  const csvText = req.body?.csv || req.body?.csvText || req.body?.text || '';
  const replaceClaims = req.body?.replaceClaims === true || req.body?.replaceClaims === 'true';

  try {
    const parsed = parseClaimsCsv(csvText);
    if (!parsed.sessions.length && parsed.errors.length) {
      return res.status(400).json({ ok: false, error: 'No valid rows', errors: parsed.errors });
    }

    const imported = importSessions(parsed.sessions, { replaceClaims });
    res.json({
      ok: true,
      imported: imported.length,
      sessions: imported,
      errors: parsed.errors,
      rowCount: parsed.rowCount,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/post-live/vods/register', async (req, res) => {
  const { videoId, title, url, streamer, durationSec, published } = req.body || {};
  if (!videoId && !url) return res.status(400).json({ ok: false, error: 'videoId or url required' });
  try {
    const session = upsertSession({
      videoId,
      title,
      url,
      streamer,
      durationSec,
      published,
      sessionKind: 'live_archive',
      repurposeMode: 'timestamp',
    });
    res.json({ ok: true, session });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/post-live/sessions/:videoId/preview', async (req, res) => {
  const { videoId } = req.params;
  const session = getSession(videoId);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

  const { start_s, end_s, candidateIndex } = req.body || {};
  try {
    const { getOrExtractPreviewMp4 } = require('../post_live/vod_preview');
    const result = await getOrExtractPreviewMp4({
      videoId,
      vodUrl: session.url,
      start_s,
      end_s,
    });

    if (Number.isInteger(candidateIndex) && session.candidates?.[candidateIndex]) {
      const candidates = session.candidates.slice();
      candidates[candidateIndex] = {
        ...candidates[candidateIndex],
        previewUrl: result.previewUrl,
        previewCached: result.cached,
      };
      patchSession(videoId, { candidates });
    }

    res.json({ ok: true, ...result, videoId });
  } catch (e) {
    console.error('[post-live/preview]', videoId, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/post-live/sessions/:videoId/analyze', async (req, res) => {
  const { videoId } = req.params;
  let session = getSession(videoId);
  if (!session) return res.status(404).json({ ok: false, error: 'Import claims CSV or register VOD first' });

  if (analyzeJobs.get(videoId) === 'running') {
    return res.json({ ok: true, videoId, analyzeStatus: 'running', message: 'Analysis already in progress' });
  }

  const clipCount = Math.max(3, Math.min(12, parseInt(req.body?.clipCount, 10) || 8));
  analyzeJobs.set(videoId, 'running');
  patchSession(videoId, { analyzeStatus: 'running', analyzeError: null });

  res.json({ ok: true, videoId, analyzeStatus: 'running', message: 'Gemini multimodal review started — VOD samples + comp style (~3-8 min)' });

  setImmediate(async () => {
    try {
      const updated = await analyzeVodSession(session, { clipCount });
      patchSession(videoId, updated);
      analyzeJobs.set(videoId, 'done');
    } catch (e) {
      console.error('[post-live/analyze]', videoId, e.message);
      patchSession(videoId, { analyzeStatus: 'failed', analyzeError: e.message });
      analyzeJobs.set(videoId, 'failed');
    }
  });
});

router.post('/post-live/vods/sync-from-channel', async (req, res) => {
  try {
    const refresh = req.body?.refresh === true;
    const limit = parseInt(req.body?.limit, 10) || 30;
    const data = await fetchLiveVods({ refresh, limit, category: req.body?.category || 'Streaming' });
    const synced = data.vods.map((v) => upsertSession({
      videoId: v.videoId,
      title: v.title,
      url: v.url,
      durationSec: v.durationSec,
      published: v.published,
      views: v.views,
      category: v.category,
      streamer: v.streamer,
    }));
    res.json({ ok: true, synced: synced.length, sessions: synced });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
