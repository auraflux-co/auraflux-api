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
