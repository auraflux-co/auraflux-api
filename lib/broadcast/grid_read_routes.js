'use strict';

/** Read-only live-grid routes shared by sidecar and localhost (CPD-1055). */

function registerLiveGridReadRoutes(app) {
  app.get('/live-grid/followed-bench', async (req, res) => {
    const { getFollowedBench, getAllFollows, FOLLOWS_USER, loadUserToken } = require('../live_grid/follows');
    const { DEFAULT_ROSTER } = require('../live_grid/poller');
    const all = await getAllFollows();
    const bench = await getFollowedBench({ roster: DEFAULT_ROSTER });
    if (!all && !bench) {
      return res.status(400).json({
        ok: false,
        error: `No Twitch user token (or expired) — connect at /connect/twitch as ${FOLLOWS_USER}`,
      });
    }
    const tokenUser = loadUserToken()?.login || FOLLOWS_USER;
    res.json({
      ok: true,
      user: tokenUser,
      count: (all || bench || []).length,
      follows: all || [],
      bench: bench || [],
      roster: DEFAULT_ROSTER,
    });
  });

  app.get('/live-grid/event-feed/preview', async (req, res) => {
    try {
      const { resolveActiveEvent } = require('../live_grid/event_calendar');
      const { pickEventFeed } = require('../live_grid/event_feed_picker');
      const { loadFeedSources } = require('../live_grid/feed_allowlist');
      const activeEvent = resolveActiveEvent();
      const eventId = req.query.eventId || activeEvent?.eventId;
      const feed = await pickEventFeed({
        eventId,
        eventTitle: activeEvent?.eventTitle,
        activeEvent: activeEvent ? { ...activeEvent, eventId: eventId || activeEvent.eventId } : null,
      });
      res.json({
        ok: true,
        activeEvent,
        feed,
        configPath: process.env.LIVE_GRID_FEED_SOURCES || 'config/live_grid_feed_sources.json',
        spec: eventId ? loadFeedSources().events?.[eventId] : null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/live-grid/discovery/bench', async (req, res) => {
    try {
      const { DEFAULT_ROSTER } = require('../live_grid/poller');
      const { getFollowedBench } = require('../live_grid/follows');
      const { fetchPlatformTopLive, mergePlatformBench } = require('../live_grid/discovery');
      const roster = DEFAULT_ROSTER;
      const follows = await getFollowedBench({ roster });
      const platform = await fetchPlatformTopLive();
      const bench = mergePlatformBench({ roster, follows: follows || [], platform });
      res.json({
        ok: true,
        followsCount: follows?.length || 0,
        platformTop: platform.slice(0, 20),
        benchCount: bench.length,
        bench: bench.slice(0, 50),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/live-grid/analytics/hourly', async (req, res) => {
    try {
      const yt = require('../services/youtube_direct');
      const { fetchHourlyWatch, aggregateByHour, recommendGridWindow } = require('../live_grid/hourly_analytics');
      const ch = await yt.getChannelInfo();
      if (!ch?.id) return res.status(400).json({ ok: false, error: 'YouTube not connected' });
      const rows = await fetchHourlyWatch(ch.id, { days: Number(req.query.days) || 14 });
      const hourly = aggregateByHour(rows);
      const recommendation = recommendGridWindow(hourly);
      res.json({ ok: true, channelId: ch.id, rows: rows.slice(-48), hourly, recommendation });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.response?.data?.error?.message || e.message });
    }
  });

  app.get('/live-grid/allowlist', (req, res) => {
    try {
      const { loadAllowlist } = require('../live_grid/rights_registry');
      res.json({ ok: true, ...loadAllowlist() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/live-grid/files', (req, res) => {
    try {
      const { listEligibleGridFiles } = require('./ops');
      const files = listEligibleGridFiles();
      res.json({ ok: true, count: files.length, files });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { registerLiveGridReadRoutes };
