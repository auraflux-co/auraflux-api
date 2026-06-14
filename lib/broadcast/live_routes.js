/**
 * Live broadcast routes — shared by server.js and broadcast sidecar.
 * ffmpeg / RTMP lives here so auraflux can restart without killing streams.
 */

const axios = require('axios');

function resolveLiveTvStartOpts(body = {}) {
  const opts = { ...body };
  if (!opts.videos?.length) {
    const { loadCuratedPlaylist } = require('../live_tv/curated_playlist');
    const curated = loadCuratedPlaylist();
    if (curated?.videos?.length) {
      opts.videos = curated.videos;
      if (curated.curated) opts.curated = true;
    }
  }
  return opts;
}

function registerLiveBroadcastRoutes(app, state = {}) {
  const getGrid = () => state.grid;
  const setGrid = (v) => { state.grid = v; };
  const getTv = () => state.tv;
  const setTv = (v) => { state.tv = v; };

  function startLiveTv(body = {}) {
    const { LiveTvManager } = require('../live_tv/manager');
    const mgr = new LiveTvManager();
    setTv(mgr);
    return mgr.start(resolveLiveTvStartOpts(body));
  }

  // --- Live Grid (manager routes only) ---
  app.post('/live-grid/prepare', async (req, res) => {
    try {
      if (getGrid()?.running) {
        return res.status(400).json({ ok: false, error: 'Live grid already running' });
      }
      const { LiveGridManager } = require('../live_grid/manager');
      const mgr = new LiveGridManager();
      const result = await mgr.prepare(req.body || {});
      res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[live-grid] prepare failed:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/live-grid/prepared', (req, res) => {
    const { loadPrepared, preparedIsStale, scheduleAheadEnabled } = require('../live_grid/prepared_broadcast');
    const prepared = loadPrepared();
    res.json({
      ok: true,
      scheduleAheadEnabled: scheduleAheadEnabled(),
      prepared: prepared ? {
        watchUrl: prepared.watchUrl,
        broadcastId: prepared.broadcastId,
        scheduledStartTime: prepared.scheduledStartTime,
        savedAt: prepared.savedAt,
        stale: preparedIsStale(prepared),
      } : null,
    });
  });

  app.post('/live-grid/prepared/clear', (req, res) => {
    const { clearPrepared } = require('../live_grid/prepared_broadcast');
    clearPrepared();
    res.json({ ok: true, message: 'Prepared broadcast cleared' });
  });

  app.post('/live-grid/prepare/refresh', async (req, res) => {
    try {
      if (getGrid()?.running) {
        return res.status(400).json({ ok: false, error: 'Live grid already running' });
      }
      const { LiveGridManager } = require('../live_grid/manager');
      const mgr = new LiveGridManager();
      const result = await mgr.refreshPrepared(req.body || {});
      res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[live-grid] prepare refresh failed:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-grid/program-mode', async (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    const { mode } = req.body || {};
    if (!mode) return res.status(400).json({ ok: false, error: 'mode required' });
    try {
      const result = await mgr.setProgramMode(mode);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-grid/avatar-pip/sync', (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    try {
      const result = mgr._syncAvatarPip(mgr._programLayout);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-grid/start', async (req, res) => {
    try {
      if (getGrid()?.running) {
        return res.status(400).json({ ok: false, error: 'Live grid already running', status: getGrid().status() });
      }
      const { LiveGridManager } = require('../live_grid/manager');
      const mgr = new LiveGridManager({ onAutoStop: async () => setGrid(null) });
      setGrid(mgr);
      const status = await mgr.start(req.body || {});
      res.json({ ok: true, status });
    } catch (e) {
      console.error('[live-grid] start failed:', e.message);
      try { await getGrid()?.stop(); } catch (_) {}
      setGrid(null);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-grid/stop', async (req, res) => {
    const mgr = getGrid();
    if (!mgr) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    const watchUrl = mgr.broadcast?.watchUrl || null;
    await mgr.stop();
    setGrid(null);
    res.json({ ok: true, message: 'Live grid stopped — VOD remains on the channel', watchUrl });
  });

  app.post('/live-grid/roster', (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    const lists = mgr.poller.updateRoster(req.body || {});
    mgr.poller.pollOnce().catch(() => {});
    res.json({ ok: true, ...lists });
  });

  app.post('/live-grid/master-refresh', (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    const reason = req.body?.reason || 'operator';
    res.json({ ok: true, ...mgr.refreshMasterEncoder(reason) });
  });

  app.post('/live-grid/refresh-youtube-seo', async (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    try {
      const { reason, programMode, headline } = req.body || {};
      const result = await mgr.refreshYoutubeSeo(reason || 'operator', { programMode, headline });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-grid/audio', (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    const { quadrant } = req.body || {};
    const arg = quadrant === 'auto' ? 'auto' : Number(quadrant) - 1;
    const switched = mgr.setAudio(arg, 'manual');
    res.json({ ok: true, switched, audio: mgr.status().audio });
  });

  app.post('/live-grid/audio/panic-mute', (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    const audio = mgr.panicMute((req.body || {}).reason || 'operator-panic');
    res.json({ ok: true, audio });
  });

  app.post('/live-grid/audio/unmute', (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    mgr._clearAudioProtect();
    res.json({ ok: true, audio: mgr.status().audio });
  });

  app.get('/live-grid/youtube-sync', async (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.json({ ok: true, running: false });
    try {
      const info = mgr.youtubeSync ? await mgr.youtubeSync.probe() : mgr.status().youtube;
      res.json({ ok: true, ...info, running: mgr.running });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/live-grid/status', (req, res) => {
    const mgr = getGrid();
    if (!mgr) return res.json({ ok: true, running: false, sidecar: true });
    res.json({ ok: true, ...mgr.status() });
  });

  app.get('/live-grid/program/status', (req, res) => {
    try {
      const { ProgramDirector } = require('../live_grid/program_director');
      const mgr = getGrid();
      const director = mgr?.programDirector || new ProgramDirector();
      const layout = mgr?.running
        ? mgr._programLayout
        : director.layout([null, null, null, null]);
      res.json({
        ok: true,
        running: !!mgr?.running,
        ...director.status(),
        layout: layout ? {
          mode: layout.mode,
          modeLabel: layout.modeLabel,
          title: layout.title,
          sources: layout.sources,
          filePaths: layout.filePaths,
          eventFeed: layout.eventFeed || mgr?._eventFeed || null,
          activeEvent: layout.activeEvent,
        } : null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-grid/quadrant/:n/file', (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    const q = Number(req.params.n) - 1;
    const { path: filePath, label } = req.body || {};
    if (!filePath) return res.status(400).json({ ok: false, error: 'path required' });
    try {
      const quadrant = mgr.setQuadrantFile(q, filePath, label);
      res.json({ ok: true, quadrant });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-grid/quadrant/:n/url', (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    const q = Number(req.params.n) - 1;
    const { url, label, title, login } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: 'url required' });
    try {
      const quadrant = mgr.setQuadrantUrl(q, url, label, { title, login });
      res.json({ ok: true, quadrant, locked: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-grid/quadrant/:n/channel', (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    const q = Number(req.params.n) - 1;
    const { login } = req.body || {};
    if (!login) return res.status(400).json({ ok: false, error: 'login required' });
    try {
      const quadrant = mgr.setQuadrantChannel(q, login);
      res.json({ ok: true, quadrant, locked: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-grid/quadrant/:n/unlock', (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    const q = Number(req.params.n) - 1;
    try {
      mgr.clearQuadrantLock(q);
      mgr.poller?.pollOnce().catch(() => {});
      res.json({ ok: true, quadrant: q + 1 });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-grid/operator-mode', (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    const enabled = req.body?.enabled ?? req.body?.operatorMode;
    if (enabled === undefined) return res.status(400).json({ ok: false, error: 'enabled required' });
    try {
      const out = mgr.setOperatorMode(!!enabled);
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // --- ClipzWorld TV ---
  app.post('/live-tv/start', (req, res) => {
    try {
      if (getTv()?.running) {
        return res.status(400).json({ ok: false, error: 'ClipzWorld TV already running', status: getTv().status() });
      }
      const status = startLiveTv(req.body || {});
      res.json({ ok: true, status });
    } catch (e) {
      console.error('[live-tv] start failed:', e.message);
      try { getTv()?.stop(); } catch (_) {}
      setTv(null);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-tv/restart', (req, res) => {
    try {
      if (getTv()?.running) {
        getTv().stop();
        setTv(null);
      }
      const status = startLiveTv(req.body || {});
      res.json({ ok: true, status });
    } catch (e) {
      console.error('[live-tv] restart failed:', e.message);
      try { getTv()?.stop(); } catch (_) {}
      setTv(null);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/live-tv/playlist', (req, res) => {
    try {
      const pl = require('../live_tv/curated_playlist');
      const curated = pl.loadCuratedPlaylist();
      const catalog = pl.buildTvCatalog();
      const selected = new Set(curated?.videos || []);
      const recommended = pl.recommendedPlaylist(catalog);
      const pathMod = require('path');
      const mgr = getTv();
      res.json({
        ok: true,
        curated,
        catalog: pl.markSelected(catalog, selected),
        recommended: recommended.map((abs) => ({
          abs,
          path: pathMod.relative(pl.REPO_ROOT, abs).replace(/\\/g, '/'),
          label: pl.friendlyTvLabel(pathMod.basename(abs)),
        })),
        running: mgr?.running ? mgr.status() : { running: false },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-tv/playlist', (req, res) => {
    try {
      const pl = require('../live_tv/curated_playlist');
      const videos = req.body?.videos;
      if (!Array.isArray(videos) || !videos.length) {
        return res.status(400).json({ ok: false, error: 'Pick at least one video' });
      }
      const saved = pl.saveCuratedPlaylist({
        videos,
        notes: req.body?.notes || 'Saved from Broadcast dashboard',
        targetDurationMin: req.body?.targetDurationMin || null,
      });
      let mgr = getTv();
      let status = mgr?.running ? mgr.status() : { running: false };
      if (req.body?.apply) {
        if (mgr?.running) {
          mgr.stop();
          setTv(null);
        }
        status = startLiveTv({ videos: saved.videos, curated: true });
      }
      res.json({ ok: true, curated: saved, status });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-tv/stop', (req, res) => {
    const mgr = getTv();
    if (!mgr) return res.status(400).json({ ok: false, error: 'ClipzWorld TV not running' });
    mgr.stop();
    setTv(null);
    res.json({ ok: true, message: 'ClipzWorld TV stopped' });
  });

  app.get('/live-tv/status', (req, res) => {
    const mgr = getTv();
    if (!mgr) return res.json({ ok: true, running: false, sidecar: true });
    res.json({ ok: true, ...mgr.status() });
  });

  /** Main server calls this after publish when sidecar owns TV. */
  app.post('/live-tv/enqueue', (req, res) => {
    try {
      const mgr = getTv();
      const { file } = req.body || {};
      if (!mgr?.running) return res.json({ ok: false, error: 'TV not running' });
      if (mgr.curated) return res.json({ ok: false, skipped: true, reason: 'curated playlist' });
      if (!file) return res.status(400).json({ ok: false, error: 'file required' });
      const added = mgr.enqueue(file);
      res.json({ ok: added, added });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/live-broadcast/health', (req, res) => {
    res.json({
      ok: true,
      service: 'broadcast-sidecar',
      tvRunning: !!getTv()?.running,
      gridRunning: !!getGrid()?.running,
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime()),
    });
  });
}

module.exports = { registerLiveBroadcastRoutes, resolveLiveTvStartOpts };
