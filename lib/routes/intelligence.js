'use strict';
/**
 * CPD-1193 — Intelligence API routes (C0 localhost).
 */

const express = require('express');
const intelligence = require('../intelligence');
const analytics = require('../analytics');
const seo = require('../seo');
const { requireC0Localhost } = require('../middleware/c0_only');

const router = express.Router();

router.use(requireC0Localhost);

router.get('/intelligence/stats', (_req, res) => {
  res.json({ ok: true, stats: intelligence.memoryStats() });
});

router.get('/intelligence/videos', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const videos = intelligence.listVideos({
    limit,
    contentType: req.query.contentType || null,
    streamer: req.query.streamer || null,
  });
  res.json({ ok: true, count: videos.length, videos });
});

router.get('/intelligence/top', (req, res) => {
  const performers = intelligence.topPerformers({
    metric: req.query.metric || 'views',
    contentType: req.query.contentType || null,
    streamer: req.query.streamer || null,
    limit: parseInt(req.query.limit, 10) || 10,
  });
  res.json({ ok: true, performers });
});

router.get('/intelligence/recommend-context', (req, res) => {
  const ctx = intelligence.recommendContext({
    contentType: req.query.contentType || null,
    streamer: req.query.streamer || null,
    formFactor: req.query.formFactor || 'short',
    limit: parseInt(req.query.limit, 10) || 5,
  });
  res.json(ctx);
});

router.get('/intelligence/decisions/:jobId', (req, res) => {
  const decisions = intelligence.memory.listDecisions(req.params.jobId, {
    limit: parseInt(req.query.limit, 10) || 20,
  });
  res.json({ ok: true, jobId: req.params.jobId, decisions });
});

router.post('/intelligence/sync', async (req, res) => {
  try {
    const platform = req.body?.platform || req.query.platform || 'youtube';
    const payload = await intelligence.syncPerformance(platform, {
      videoId: req.body?.videoId || req.query.videoId,
      days: parseInt(req.body?.days || req.query.days, 10) || 28,
      limit: parseInt(req.body?.limit || req.query.limit, 10) || 50,
    });
    res.json({ ok: true, platform, ...payload });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/intelligence/backfill', (req, res) => {
  try {
    const result = intelligence.backfillFromJobs({
      limit: parseInt(req.body?.limit || req.query.limit, 10) || 100,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/intelligence/reconcile', (_req, res) => {
  try {
    const result = intelligence.reconcileOutcomes();
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get('/intelligence/publish-context', (req, res) => {
  const block = intelligence.getPublishIntelligenceContext({
    contentType: req.query.contentType || null,
    streamer: req.query.streamer || null,
    formFactor: req.query.formFactor || 'short',
  });
  res.json({ ok: true, ...block });
});

router.get('/intelligence/seo-keywords', (req, res) => {
  let publishCopy = null;
  if (req.query.publishCopy) {
    try {
      publishCopy = JSON.parse(req.query.publishCopy);
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid publishCopy JSON' });
    }
  }
  const intelligenceContext = intelligence.recommendContext({
    contentType: req.query.contentType || null,
    streamer: req.query.streamer || null,
    formFactor: req.query.formFactor || 'short',
  });
  const block = seo.buildKeywordContext({ publishCopy, intelligenceContext });
  res.json(block);
});

router.post('/intelligence/competitors/sync', async (req, res) => {
  try {
    const competitors = require('../intelligence/competitors');
    const out = await competitors.syncCompetitors({
      handles: req.body?.handles || undefined,
      limitPerChannel: parseInt(req.body?.limitPerChannel, 10) || undefined,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/intelligence/competitors', (req, res) => {
  try {
    const competitors = require('../intelligence/competitors');
    res.json({
      ok: true,
      videos: competitors.listCompetitorVideos({ channel: req.query.channel || undefined, limit: parseInt(req.query.limit, 10) || 50 }),
      outliers: competitors.detectOutliers({ limit: 20 }),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/intelligence/competitors/roster', (_req, res) => {
  try {
    const competitors = require('../intelligence/competitors');
    res.json({ ok: true, ...competitors.getCompetitorRoster() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// CPD-1218 — model self-scoring: predicted band vs reconciled actual views
router.get('/intelligence/prediction-accuracy', (req, res) => {
  try {
    const predict = require('../intelligence/predict');
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    res.json({ ok: true, ...predict.predictionAccuracy({ limit }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// CPD-1219 phase 2 — YouTube keyword search per roster streamer (daily cached)
router.post('/intelligence/competitors/search-streamers', async (req, res) => {
  try {
    const competitors = require('../intelligence/competitors');
    const out = await competitors.syncStreamerSearch({
      streamers: Array.isArray(req.body?.streamers) ? req.body.streamers : undefined,
      limitPerStreamer: parseInt(req.body?.limitPerStreamer, 10) || undefined,
      force: !!req.body?.force,
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// CPD-1210 — score clip candidates against Content Memory patterns
router.post('/intelligence/predict', (req, res) => {
  try {
    const predict = require('../intelligence/predict');
    const candidates = Array.isArray(req.body?.candidates) ? req.body.candidates : [];
    if (!candidates.length) return res.status(400).json({ ok: false, error: 'candidates array required' });
    res.json({ ok: true, candidates: predict.scoreCandidates(candidates) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/intelligence/ab-tests', async (req, res) => {
  try {
    const ab = require('../intelligence/ab_rotation');
    const test = await ab.startTest({
      platformVideoId: req.body?.platformVideoId,
      jobId: req.body?.jobId || null,
      kind: req.body?.kind,
      variantA: req.body?.variantA,
      variantB: req.body?.variantB,
    });
    res.json({ ok: true, test });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get('/intelligence/ab-tests', (req, res) => {
  try {
    const ab = require('../intelligence/ab_rotation');
    res.json({ ok: true, tests: ab.listTests({ status: req.query.status || undefined }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/intelligence/ab-tests/rotate', async (req, res) => {
  try {
    const ab = require('../intelligence/ab_rotation');
    const out = await ab.rotateDue({ rotationHours: parseInt(req.body?.rotationHours, 10) || undefined });
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// CPD-1238 — vidIQ/TB-style publish optimize score (0–100)
router.post('/intelligence/optimize-score', (req, res) => {
  try {
    const { scorePublishMetadata } = require('../publish_optimize');
    const block = scorePublishMetadata(req.body || {});
    res.json({ ok: true, ...block });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// CPD-1239 — publish schedule heatmap (day×hour ET)
router.get('/intelligence/schedule-heatmap', async (req, res) => {
  try {
    const { fetchHourlyWatch } = require('../live_grid/hourly_analytics');
    const { buildDayHourGrid, topPublishSlots, normalizeHeatmap } = require('../schedule_heatmap');
    const channelId = req.query.channelId || process.env.YOUTUBE_CHANNEL_ID;
    if (!channelId) return res.status(400).json({ ok: false, error: 'channelId required' });
    const days = Math.min(90, parseInt(req.query.days, 10) || 28);
    const rows = await fetchHourlyWatch(channelId, { days });
    const grid = buildDayHourGrid(rows);
    res.json({
      ok: true,
      days,
      channelId,
      grid: normalizeHeatmap(grid),
      topSlots: topPublishSlots(grid, { limit: parseInt(req.query.limit, 10) || 8 }),
      rawHourlyCount: rows.length,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get('/intelligence/optimize-feed', (req, res) => {
  try {
    const { persistedJobs } = require('../job_card');
    const { scorePublishMetadata } = require('../publish_optimize');
    const limit = Math.min(30, parseInt(req.query.limit, 10) || 12);
    const items = Object.values(persistedJobs)
      .filter((j) => j && (j.id || j.jobId))
      .filter((j) => j.publishCopy || j.publishPrep || j.finalUrl || j.driveUrl)
      .sort((a, b) => new Date(b.savedAt || b.createdAt || 0) - new Date(a.savedAt || a.createdAt || 0))
      .slice(0, limit)
      .map((j) => {
        const pc = j.publishCopy || {};
        const prep = j.publishPrep || {};
        const title = pc.title || prep.title || j.title || '';
        const description = pc.description || prep.description || '';
        const tags = pc.tags || prep.tags || [];
        const keyword = j.primaryKeyword
          || (j.compositionSpec && j.compositionSpec.primaryKeyword)
          || null;
        const optimize = scorePublishMetadata({
          title,
          description,
          tags,
          primaryKeyword: keyword,
          hasThumbnail: !!(j.thumbnail || j.thumbnailUrl),
        });
        return {
          jobId: j.id || j.jobId,
          title,
          contentType: j.contentType || null,
          stage: j.stage || j.status || null,
          optimize,
          primaryKeyword: keyword,
        };
      });
    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// CPD-1241 — vidIQ MCP bridge + C0 side-by-side benchmarks
router.get('/intelligence/vidiq/status', async (_req, res) => {
  try {
    const vidiq = require('../intelligence/adapters/vidiq_mcp');
    const { listScenarios } = require('../intelligence/vidiq_compare');
    const out = {
      ok: true,
      configured: vidiq.isConfigured(),
      mcpUrl: vidiq.DEFAULT_MCP_URL,
      scenarios: listScenarios(),
      c0Scope: 'ClipzWorld News Content Memory + competitor catalog',
      vidiqScope: 'Platform-wide YouTube/Instagram intelligence (135M+ channels)',
    };
    if (vidiq.isConfigured()) {
      try {
        out.credits = await vidiq.getCreditsBalance();
      } catch (e) {
        out.creditsError = e.message;
      }
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/intelligence/vidiq/tools', async (_req, res) => {
  try {
    const vidiq = require('../intelligence/adapters/vidiq_mcp');
    if (!vidiq.isConfigured()) {
      return res.status(400).json({ ok: false, error: 'VIDIQ_MCP_API_KEY not set' });
    }
    const tools = await vidiq.listTools();
    res.json({
      ok: true,
      count: tools.length,
      tools: tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: (t.description || '').slice(0, 240),
      })),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/intelligence/vidiq/compare', async (req, res) => {
  try {
    const { runScenario, runBenchmarkSuite } = require('../intelligence/vidiq_compare');
    const body = req.body || {};
    if (body.scenario) {
      const row = await runScenario(body.scenario, body.input || {});
      return res.json({ ok: true, result: row });
    }
    const report = await runBenchmarkSuite(body.input || {}, {
      scenarios: body.scenarios,
    });
    res.json(report);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/intelligence/vidiq/call', async (req, res) => {
  try {
    const vidiq = require('../intelligence/adapters/vidiq_mcp');
    if (!vidiq.isConfigured()) {
      return res.status(400).json({ ok: false, error: 'VIDIQ_MCP_API_KEY not set' });
    }
    const { tool, arguments: args } = req.body || {};
    if (!tool) return res.status(400).json({ ok: false, error: 'tool required' });
    const result = await vidiq.callTool(tool, args || {});
    res.json({ ok: true, tool, result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get('/seo/demand', async (req, res) => {
  try {
    const seeds = String(req.query.seeds || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const intelligenceContext = intelligence.recommendContext({
      contentType: req.query.contentType || null,
      streamer: req.query.streamer || null,
      formFactor: req.query.formFactor || 'short',
    });
    const block = await seo.buildDemandContext({
      seeds,
      intelligenceContext,
      region: req.query.region || 'US',
    });
    res.json(block);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/analytics/ready', (_req, res) => {
  res.json({
    ok: true,
    youtube: analytics.isAnalyticsReady('youtube'),
  });
});

router.get('/analytics/channel-summary', async (req, res) => {
  try {
    const channelId = req.query.channelId || process.env.YOUTUBE_CHANNEL_ID;
    if (!channelId) return res.status(400).json({ ok: false, error: 'channelId required' });
    const summary = await analytics.fetchChannelSummary('youtube', channelId, {
      days: parseInt(req.query.days, 10) || 28,
    });
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
