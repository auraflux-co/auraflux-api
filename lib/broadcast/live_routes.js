/**
 * Live broadcast routes — shared by server.js and broadcast sidecar.
 * ffmpeg / RTMP lives here so auraflux can restart without killing streams.
 */

const axios = require('axios');

/** Reused env RTMP + broadcast id — stop should not end YouTube unless asked. */
function gridUsesRtmpBypass() {
  return !!(
    (process.env.LIVE_GRID_RTMP_URL || process.env.YOUTUBE_LIVE_RTMP_URL) &&
    (process.env.LIVE_GRID_BROADCAST_ID || process.env.LIVE_GRID_WATCH_URL)
  );
}

function resolveLiveGridStopOpts(body = {}) {
  const endBroadcast = body?.endBroadcast === true;
  const skipEndBroadcast = body?.skipEndBroadcast === true
    || body?.reason === 'shutdown'
    || !endBroadcast;
  return { skipEndBroadcast, endBroadcast };
}

/** End the env-pinned YouTube broadcast when the grid encoder is already stopped. */
async function endYoutubeBroadcastFromEnv(log = () => {}) {
  const yt = require('../services/youtube_direct');
  const bid = process.env.LIVE_GRID_BROADCAST_ID
    || (process.env.LIVE_GRID_WATCH_URL || '').match(/[?&]v=([^&]+)/)?.[1];
  if (!bid) throw new Error('LIVE_GRID_BROADCAST_ID not set');
  await yt.endLiveBroadcast(bid);
  log(`YouTube broadcast ${bid} ended`);
  return { broadcastId: bid };
}

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

  const { registerLiveGridReadRoutes } = require('./grid_read_routes');
  registerLiveGridReadRoutes(app);

  function gridOnAutoStop() {
    try {
      const { clearResume } = require('../live_grid/resume_state');
      clearResume();
    } catch (_) {}
    setGrid(null);
  }

  function makeLiveGridManager() {
    const { LiveGridManager } = require('../live_grid/manager');
    return new LiveGridManager({ onAutoStop: async () => gridOnAutoStop() });
  }

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
    const { mode, fileOverrides, headline } = req.body || {};
    if (!mode) return res.status(400).json({ ok: false, error: 'mode required' });
    try {
      const result = await mgr.setProgramMode(mode, { fileOverrides, headline });
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

  app.get('/live-grid/youtube-listing', async (req, res) => {
    try {
      const { readYoutubeListing } = require('../live_grid/youtube_listing_env');
      const listing = readYoutubeListing();
      const out = { ok: true, listing };
      if (req.query.probe !== '0' && listing.broadcastId) {
        const yt = require('../services/youtube_direct');
        if (yt.isConnected()) {
          try {
            const st = await yt.getBroadcastStatus(listing.broadcastId);
            if (!st) {
              out.probe = { attachable: false, reason: 'not_found' };
            } else if (st.lifeCycleStatus === 'complete') {
              out.probe = { attachable: false, reason: 'complete', lifeCycleStatus: st.lifeCycleStatus };
            } else {
              out.probe = {
                attachable: true,
                lifeCycleStatus: st.lifeCycleStatus,
                privacyStatus: st.privacyStatus,
                title: st.title,
              };
            }
          } catch (e) {
            out.probe = { attachable: null, reason: 'api_error', message: e.message };
          }
        } else {
          out.probe = { attachable: null, reason: 'youtube_not_connected' };
        }
      }
      out.goLiveHint = !listing.broadcastId
        ? 'GO LIVE will create a new YouTube listing'
        : (listing.stale || out.probe?.attachable === false)
          ? 'Pinned listing ended — GO LIVE will create a fresh listing automatically'
          : out.probe?.attachable === true
            ? 'GO LIVE will reuse the pinned listing (same watch URL / stats)'
            : 'GO LIVE will validate the pinned listing, or create fresh if needed';
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-grid/youtube-listing', (req, res) => {
    try {
      const { persistYoutubeListing, readYoutubeListing } = require('../live_grid/youtube_listing_env');
      const { broadcastId, watchUrl } = req.body || {};
      if (broadcastId == null) {
        return res.status(400).json({ ok: false, error: 'broadcastId required (empty string clears)' });
      }
      const result = persistYoutubeListing({ broadcastId, watchUrl });
      res.json({ ok: true, listing: readYoutubeListing(), ...result });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-grid/start', async (req, res) => {
    try {
      if (getGrid()?.running) {
        return res.status(400).json({ ok: false, error: 'Live grid already running', status: getGrid().status() });
      }
      const body = req.body || {};
      if (body.rtmpGo === true) body._rtmpGo = true;
      if (body.broadcastId) {
        const { persistYoutubeListing } = require('../live_grid/youtube_listing_env');
        persistYoutubeListing({ broadcastId: body.broadcastId, watchUrl: body.watchUrl });
      }
      const mgr = makeLiveGridManager();
      setGrid(mgr);
      const status = await mgr.start(body);
      try {
        const { saveResumeFromManager } = require('../live_grid/resume_state');
        saveResumeFromManager(mgr);
      } catch (_) {}
      res.json({ ok: true, status });
    } catch (e) {
      console.error('[live-grid] start failed:', e.message);
      try { await getGrid()?.stop(); } catch (_) {}
      setGrid(null);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-grid/stop', async (req, res) => {
    const stopOpts = resolveLiveGridStopOpts(req.body || {});
    const mgr = getGrid();
    if (!mgr) {
      if (!stopOpts.endBroadcast) {
        return res.status(400).json({ ok: false, error: 'Live grid not running' });
      }
      try {
        const { clearResume } = require('../live_grid/resume_state');
        clearResume();
        const ended = await endYoutubeBroadcastFromEnv();
        return res.json({
          ok: true,
          message: 'YouTube broadcast ended (encoder was already stopped)',
          endBroadcast: true,
          broadcastId: ended.broadcastId,
        });
      } catch (e) {
        return res.status(500).json({ ok: false, error: e.message });
      }
    }
    const watchUrl = mgr.broadcast?.watchUrl || null;
    if (stopOpts.endBroadcast) {
      try {
        const { clearResume } = require('../live_grid/resume_state');
        clearResume();
      } catch (_) {}
    }
    await mgr.stop(stopOpts);
    setGrid(null);
    const message = stopOpts.endBroadcast
      ? 'Live grid stopped — broadcast ended on YouTube'
      : 'Encoder stopped — YouTube listing kept open (GO LIVE again to reattach RTMP)';
    res.json({ ok: true, message, watchUrl, endBroadcast: !!stopOpts.endBroadcast });
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

  app.post('/live-grid/rtmp-go', async (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    try {
      const result = await mgr.startRtmp();
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-grid/listing/privacy', async (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    try {
      await mgr._applyListingPrivacy(req.body?.privacyStatus || 'public');
      res.json({ ok: true, status: mgr.status() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/live-grid/solo-listings', (req, res) => {
    try {
      const { readSoloListings, soloStreamsEnabled, soloStreamsConfigured } = require('../live_grid/solo_listings_env');
      res.json({
        ok: true,
        enabled: soloStreamsEnabled(),
        configured: soloStreamsConfigured(),
        listings: readSoloListings(),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-grid/solo-listings', (req, res) => {
    try {
      const { persistSoloListing, readSoloListingForQuadrant } = require('../live_grid/solo_listings_env');
      const { quadrant, broadcastId, watchUrl, rtmpUrl, streamId, label } = req.body || {};
      const q = Number(quadrant);
      if (!Number.isInteger(q) || q < 1 || q > 4) {
        return res.status(400).json({ ok: false, error: 'quadrant must be 1-4' });
      }
      if (broadcastId == null) {
        return res.status(400).json({ ok: false, error: 'broadcastId required (empty string clears)' });
      }
      const listing = persistSoloListing(q - 1, { broadcastId, watchUrl, rtmpUrl, streamId, label });
      res.json({ ok: true, listing: readSoloListingForQuadrant(q - 1), saved: listing });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-grid/solo-go', (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    try {
      const result = mgr.startSoloStreams();
      res.json(result);
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post('/live-grid/reload-encode', (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    res.json(mgr.reloadEncodeSettings());
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
    const { quadrant, pin } = req.body || {};
    const arg = quadrant === 'auto' ? 'auto' : Number(quadrant) - 1;
    const source = quadrant === 'auto' ? 'auto' : (pin === true ? 'manual' : 'listen');
    const switched = mgr.setAudio(arg, source);
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

  app.get('/live-grid/preflight', (req, res) => {
    try {
      const { runPreflight } = require('../live_grid/preflight');
      const skipTests = req.query.skipTests === '1' || req.query.skipTests === 'true';
      res.json({ ok: true, ...runPreflight({ skipTests }) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/live-grid/e2e-lockdown', (req, res) => {
    try {
      const { runE2eLockdown } = require('../live_grid/e2e_lockdown');
      const skipRuntime = req.query.skipRuntime === '1' || req.query.skipRuntime === 'true';
      res.json({ ok: true, ...runE2eLockdown({ skipRuntime }) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get('/live-grid/youtube-aspect', (req, res) => {
    try {
      const { checkRtmpLandscapeEncode } = require('../live_grid/rtmp_landscape_guard');
      const { describeEncodePlan } = require('../live_grid/compositor');
      const { checkLiveAspect } = require('../live_grid/youtube_aspect_check');
      const mgr = getGrid();
      const output = process.env.LIVE_GRID_RTMP_URL || null;
      const localHls = mgr?._localPreview?.hlsPath || null;
      const watchUrl = req.query.watchUrl
        || mgr?.broadcast?.watchUrl
        || process.env.LIVE_GRID_WATCH_URL
        || null;
      const encodePlan = describeEncodePlan({ output, localHlsPath: localHls });
      const guard = checkRtmpLandscapeEncode({ output, localHlsPath: localHls });
      let live = null;
      if (watchUrl && mgr?.running) {
        try {
          live = checkLiveAspect({ watchUrl, hlsPath: localHls });
        } catch (_) {}
      }
      res.json({ ok: true, watchUrl, encodePlan, guard, live });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
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

  /** Render sidecar delivery QA — poll from Render cron/worker or ops tooling (read-only). */
  app.get('/live-grid/delivery', (req, res) => {
    const mgr = getGrid();
    if (!mgr) return res.json({ ok: true, running: false, delivery: null });
    const delivery = mgr.buildDeliveryQa?.() || null;
    res.json({
      ok: true,
      running: !!mgr.running,
      broadcastId: mgr.broadcast?.broadcastId || null,
      delivery,
    });
  });

  /** Operator / sidecar — compositor-first pipeline heal (same YouTube listing). */
  app.post('/live-grid/delivery/heal', async (req, res) => {
    try {
      const mgr = getGrid();
      if (!mgr?.running) {
        return res.status(400).json({ ok: false, error: 'grid not running' });
      }
      const reason = req.body?.reason || 'manual_heal';
      const result = await mgr.healDeliveryPipeline(reason);
      res.json({ ok: result.ok, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
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

  /** Atomic bench→grid swap — one feeder change, no poll auto-fill between remove and replace. */
  app.post('/live-grid/quadrant/:n/replace', (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    const q = Number(req.params.n) - 1;
    const { remove, replace } = req.body || {};
    if (!remove && replace === undefined) {
      return res.status(400).json({ ok: false, error: 'remove and/or replace required' });
    }
    try {
      const quadrant = mgr.replaceQuadrant(q, { remove, replace });
      res.json({ ok: true, quadrant, locked: !!replace });
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

  app.post('/live-grid/sync-labels', (req, res) => {
    const mgr = getGrid();
    if (!mgr?.running) return res.status(400).json({ ok: false, error: 'Live grid not running' });
    try {
      const labels = mgr.syncQuadrantLabels();
      res.json({ ok: true, labels });
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

/** Sidecar boot — restore live grid after pm2 restart if resume state exists. */
async function autoResumeLiveGrid(state = {}) {
  const {
    autoResumeEnabled,
    loadResume,
    clearResume,
    resumeIsStale,
    buildResumeStartOpts,
    applyResumeRuntime,
    saveResumeFromManager,
  } = require('../live_grid/resume_state');

  if (!autoResumeEnabled() || state.grid?.running) {
    return { resumed: false, reason: state.grid?.running ? 'already_running' : 'disabled' };
  }

  const saved = loadResume();
  if (!saved?.shouldResume) {
    return { resumed: false, reason: 'no_state' };
  }
  if (resumeIsStale(saved)) {
    clearResume();
    return { resumed: false, reason: 'stale' };
  }

  const getGrid = () => state.grid;
  const setGrid = (v) => { state.grid = v; };

  function gridOnAutoStop() {
    try { clearResume(); } catch (_) {}
    setGrid(null);
  }

  try {
    const { LiveGridManager } = require('../live_grid/manager');
    const mgr = new LiveGridManager({ onAutoStop: async () => gridOnAutoStop() });
    setGrid(mgr);
    const startOpts = buildResumeStartOpts(saved);
    startOpts._resumeRuntime = saved.runtime;
    await mgr.start(startOpts);
    mgr.feeders?.syncNameFiles();
    await mgr.poller?.pollOnce().catch(() => {});
    saveResumeFromManager(mgr);
    console.log(`[broadcast-sidecar] live grid auto-resumed → ${mgr.broadcast?.watchUrl || 'RTMP'}`);
    return { resumed: true, watchUrl: mgr.broadcast?.watchUrl || null };
  } catch (e) {
    console.error('[broadcast-sidecar] auto-resume failed:', e.message);
    try { await state.grid?.stop({ skipEndBroadcast: true }); } catch (_) {}
    setGrid(null);
    return { resumed: false, reason: 'error', error: e.message };
  }
}

module.exports = {
  registerLiveBroadcastRoutes,
  resolveLiveTvStartOpts,
  resolveLiveGridStopOpts,
  endYoutubeBroadcastFromEnv,
  gridUsesRtmpBypass,
  autoResumeLiveGrid,
};
