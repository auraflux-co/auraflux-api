/**
 * Live Grid — grid manager (CPD-946)
 *
 * Ties the layers together:
 *   poller (CPD-942) → feeders (CPD-943) → master compositor (CPD-944)
 *     → YouTube Live broadcast (CPD-945)
 *
 * - Poller assignments are applied to the feeders every poll (idempotent).
 * - Quadrant swaps restart per-quadrant UDP relays (CPD-1006) — master RTMP
 *   stays up; legacy freeze-watchdog / SWAP_RESTART when UDP relay is off.
 * - Broadcast title refreshes on grid changes ("LIVE: a, b +2").
 * - caffeinate held while live so the Mac never sleeps mid-stream.
 */

const { spawn } = require('child_process');
const path = require('path');
const { LiveGridPoller, DEFAULT_ROSTER } = require('./poller');
const { getFollowedBench, getAllFollows } = require('./follows');
const { fetchPlatformTopLive, mergePlatformBench } = require('./discovery');
const { resolveAvatarOverlay, shouldUseAvatarPip, isOperatorChannelGrid } = require('./avatar_overlay');
const { QuadrantFeeders, generateSlate, quadUrl, writeNameFile, channelFromFeedUrl, loginsFromSources } = require('./feeders');
const { MasterCompositor, gridEncodeConfig, gridLayoutDims } = require('./compositor');
const { resolveVerticalStream } = require('./dual_broadcast');
const { MusicDetector, pickAudioQuad } = require('./music_detector');
const { YoutubeBroadcastSync } = require('./youtube_sync');
const { resolveFallbackBedPath, fallbackMusicEnabled, BED_VOLUME } = require('./fallback_music');
const { ChatControl } = require('./chat_control');
const { LikeTracker } = require('./chat_perks');
const { QuadRelays, USE_UDP_RELAY } = require('./relays');
const { rtspHasVideo } = require('./rtsp_probe');
const {
  outputMiddlewareEnabled,
  stagedSwapEnabled,
  restreamerHoldEnabled,
  middlewareStatus,
} = require('./middleware_config');
const { SwapController } = require('./swap_controller');
const { GridRestreamer } = require('./grid_restreamer');
const { generateGridSeo, formatAudioInstructions, displayName, AUDIO_INSTRUCTIONS, withLiveTitleDate } = require('./seo');
const { buildSoloLiveSeo, normalizeSoloLogin } = require('./solo_seo');
const { applyGoLiveDefaults, buildGoLiveSeo, loadGoLiveConfig } = require('./go_live_template');
const { generateLiveThumbnail } = require('./live_thumbnail');
const { ProgramDirector } = require('./program_director');
const { pickEventFeed } = require('./event_feed_picker');
const { isAllowedFilePath } = require('./file_sources');
const yt = require('../services/youtube_direct');
const { existingIngestStream, allowNewIngestStream, resolveIngestForCreate, envBroadcastAttach, trustEnvBroadcast } = require('./ingest_stream');

/** Env RTMP ingest + reused broadcast — sidecar restart must not call endLiveBroadcast. */
function usesRtmpBypass() {
  return !!(
    (process.env.LIVE_GRID_RTMP_URL || process.env.YOUTUBE_LIVE_RTMP_URL) &&
    (process.env.LIVE_GRID_BROADCAST_ID || process.env.LIVE_GRID_WATCH_URL)
  );
}
const {
  loadPrepared, savePrepared, clearPrepared, scheduleAheadEnabled,
  preparedIsStale, scheduledStartReady, gridStartIsoFromMinutes,
} = require('./prepared_broadcast');

const PROGRAM_TICK_MS = parseInt(process.env.LIVE_GRID_PROGRAM_TICK_MS || '60000', 10);

const AUDIO_LEAD_RATIO = 1.2;
const CHAT_SWITCH_COOLDOWN_MS = 30_000;
const MEMBER_SWAP_COOLDOWN_MS = parseInt(process.env.LIVE_GRID_MEMBER_SWAP_COOLDOWN_MS || '1800000', 10);
const FREEZE_FALLBACK_MS = parseInt(process.env.LIVE_GRID_FREEZE_FALLBACK_MS || '15000', 10);
const UDP_MASTER_REFRESH_MS = parseInt(process.env.LIVE_GRID_UDP_MASTER_REFRESH_MS || '0', 10);
const SWAP_RESTART_DEBOUNCE_MS = 5_000;
const SWAP_RESTART = String(process.env.LIVE_GRID_SWAP_RESTART || 'off').toLowerCase() === 'on';
const SEO_ON_SWAP = String(process.env.LIVE_GRID_SEO_ON_SWAP || 'off').toLowerCase() === 'on';
const SEO_SWAP_DEBOUNCE_MS = parseInt(process.env.LIVE_GRID_SEO_SWAP_DEBOUNCE_MS || '600000', 10);
const SOLO_SEO_SWAP_DEBOUNCE_MS = parseInt(process.env.LIVE_GRID_SOLO_SEO_SWAP_DEBOUNCE_MS || '30000', 10);
const MEMBER_ONLY_AUDIO = String(process.env.LIVE_GRID_MEMBER_ONLY_AUDIO || 'on').toLowerCase() !== 'off';
const SWAP_REQUIRES_LIKES = String(process.env.LIVE_GRID_SWAP_REQUIRES_LIKES || 'on').toLowerCase() !== 'off';
/** Fresh listing on start — default off so view/like/chat stats stay on one video ID. */
const ALWAYS_FRESH_LISTING = String(process.env.LIVE_GRID_ALWAYS_FRESH_LISTING ?? 'off').toLowerCase() === 'on';
/** Push title/tags/thumbnail on grid start — off saves YouTube API quota (edit in Studio instead). */
const SEO_ON_START = String(process.env.LIVE_GRID_SEO_ON_START ?? 'off').toLowerCase() === 'on';
/** Off during live — autotune kills ffmpeg and drops YouTube RTMP (Studio shows no reason). */
const AUTOTUNE_LIVE = String(process.env.LIVE_GRID_AUTOTUNE ?? 'off').toLowerCase() === 'on';
/** Never restart master ffmpeg mid-stream for avatar PNG refresh (protects YouTube listing). */
const PROTECT_YT_RTMP = String(process.env.LIVE_GRID_PROTECT_YT_RTMP ?? 'on').toLowerCase() !== 'off';

function gridTitle(assignments) {
  const live = assignments.filter(Boolean);
  if (!live.length) return 'ClipzWorld Live Grid';
  const lead = live.slice(0, 2).join(', ');
  const more = live.length > 2 ? ` +${live.length - 2}` : '';
  return withLiveTitleDate(`🔴 LIVE: ${lead}${more} — ClipzWorld Grid`);
}

function liveStreamFrameRate() {
  const fps = parseInt(process.env.LIVE_GRID_FPS || '60', 10);
  return `${fps}fps`;
}

/** Milliseconds until HH:MM America/New_York (next occurrence). */
function msUntilEtTime(hhmm) {
  const [h, m] = String(hhmm || '18:00').split(':').map(Number);
  const targetMin = h * 60 + m;
  let t = Date.now();
  for (let i = 0; i <= 24 * 60; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false,
    }).formatToParts(new Date(t));
    const pick = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
    const curMin = (pick('hour') % 24) * 60 + pick('minute');
    if (curMin === targetMin) {
      return Math.max(0, t - Date.now() - pick('second') * 1000);
    }
    t += 60_000;
  }
  return 0;
}

class LiveGridManager {
  constructor(opts = {}) {
    this.log = opts.log || ((m) => console.log(`[live-grid:mgr] ${m}`));
    this.onAutoStop = opts.onAutoStop || null;
    this.opts = opts;
    this.poller = null;
    this.feeders = null;
    this.relays = null;
    this.soloPublishers = null;
    this._soloAnnouncer = null;
    this.master = null;
    this.caffeinate = null;
    this.broadcast = null;
    this.verticalBroadcast = null;
    this.startedAt = null;
    this.running = false;
    this._lastAssignments = [null, null, null, null];
    this._freezeTimers = [null, null, null, null];
    this._udpRefreshTimer = null;
    this._udpRefreshPending = new Set();
    this._restartTimer = null;
    this.audioMode = 'auto';
    this.audioPinSource = null;
    this.audioQuad = 0;
    this.chat = null;
    this.likeTracker = null;
    this._lastChatSwitch = 0;
    this._memberSwapAt = new Map();
    this._swapUnlocked = false;
    this.musicDetector = null;
    this._musicFlags = [false, false, false, false];
    /** Manual audio pin quad to restore after a music-guard hop clears. */
    this._musicHopManualPin = null;
    this.audioMuted = false;
    this.fallbackMusicActive = false;
    this._fallbackMusicPath = null;
    this.audioProtectReason = null;
    this.youtubeSync = null;
    this._youtubeStatus = null;
    this.programDirector = null;
    this._programLayout = null;
    this._eventFeed = null;
    this._benchedFeeds = new Set();
    /** @type {Array<{ type: 'channel'|'url'|'file', login?, url?, path?, label?, title? }|null>} */
    this.operatorLocks = [null, null, null, null];
    this._lastPollerAssignments = [null, null, null, null];
    this._programTick = null;
    this.opts = {};
    this._goPublicTimer = null;
    this._requestedPrivacy = null;
    this._listingPrivacy = null;
  }

  async _applyListingPrivacy(privacyStatus) {
    const bid = this.broadcast?.broadcastId;
    const privacy = privacyStatus || this._requestedPrivacy || process.env.LIVE_GRID_PRIVACY || 'public';
    if (!bid || this.broadcast?.localOnly || !yt.isConnected()) return;
    if (privacy === 'private') return;
    try {
      await yt.updateBroadcastPrivacy(bid, privacy);
      this._listingPrivacy = privacy;
      this.log(`YouTube listing ${bid} privacy → ${privacy.toUpperCase()}`);
    } catch (e) {
      this.log(`YouTube privacy update failed: ${e.response?.data?.error?.message || e.message}`);
    }
  }

  _scheduleGoPublic(atEt) {
    clearTimeout(this._goPublicTimer);
    this._goPublicTimer = null;
    if (!atEt || !this.broadcast?.broadcastId) return;
    const ms = msUntilEtTime(atEt);
    this.log(`go-public scheduled ${atEt} ET (in ${Math.round(ms / 60000)} min)`);
    this._goPublicTimer = setTimeout(() => {
      this._goPublic().catch((e) => this.log(`go-public failed: ${e.message}`));
    }, ms);
    this._goPublicTimer.unref?.();
  }

  async _goPublic() {
    const bid = this.broadcast?.broadcastId;
    if (!bid) return;
    await yt.updateBroadcastPrivacy(bid, 'public');
    this.log(`YouTube listing ${bid} is now PUBLIC`);
  }

  /** Program mode used for avatar PIP — operator 4-up grid must not show news_desk PIP on Q3. */
  _pipOverlayOpts(layout, o = this.opts) {
    const locks = o._resumeRuntime?.operatorLocks || this.operatorLocks;
    const operatorChannelGrid = isOperatorChannelGrid(locks);
    const programMode = (o.programMode === 'grid' || operatorChannelGrid)
      ? 'grid'
      : (layout?.mode || 'grid');
    return {
      path: o.avatarOverlay,
      avatarOverlay: o.avatarOverlay,
      programMode,
      operatorChannelGrid,
    };
  }

  /** Poll roster + program director once — shared by prepare() and start(). */
  async _resolveLaunchLayout(o = {}) {
    let bench = o.bench;
    let refreshBench = null;
    let allFollowsOnly = [];
    let followsOnly = [];
    if (!bench) {
      const rosterList = o.roster || DEFAULT_ROSTER;
      const usePlatform = String(process.env.LIVE_GRID_PLATFORM_BENCH || 'on').toLowerCase() !== 'off';
      refreshBench = async () => {
        allFollowsOnly = (await getAllFollows()) || [];
        followsOnly = (await getFollowedBench({ roster: rosterList, exclude: o.exclude || [] })) || [];
        if (this.poller) {
          this.poller.allFollows = allFollowsOnly;
          this.poller.benchFollows = followsOnly;
        }
        if (!usePlatform) return followsOnly?.length ? followsOnly : null;
        const platform = await fetchPlatformTopLive();
        const merged = mergePlatformBench({ roster: rosterList, follows: followsOnly || [], platform });
        return merged?.length ? merged : null;
      };
      const { resolveLaunchBench } = require('./bench_resolve');
      bench = await resolveLaunchBench(refreshBench, (m) => this.log(m));
      if (bench?.length) {
        this.log(`bench: ${bench.length} channels ready for overnight fill`);
      }
    }
    this.poller = new LiveGridPoller({ roster: o.roster, bench: bench || undefined, exclude: o.exclude, refreshBench });
    if (allFollowsOnly.length) this.poller.allFollows = allFollowsOnly;
    if (followsOnly.length) this.poller.benchFollows = followsOnly;

    this.programDirector = new ProgramDirector({
      log: this.log,
      mode: o.programMode || process.env.LIVE_GRID_PROGRAM_MODE || 'auto',
    });
    if (isOperatorChannelGrid(o._resumeRuntime?.operatorLocks)) {
      this.programDirector.mode = 'grid';
    }
    this.programDirector.setOverrides({
      eventFile: o.eventFile,
      eventTitle: o.eventTitle,
      headline: o.headline,
      fileOverrides: o.fileOverrides,
    });
    if (o.eventFeedUrl) this.opts.eventFeedUrl = o.eventFeedUrl;

    const { assignments } = await this.poller.pollOnce();
    this._lastPollerAssignments = [...assignments];
    const layout = await this._applyProgram(assignments);
    this._lastAssignments = this._sourcesToLogins(layout.sources);
    this._programLayout = layout;
    return { layout, assignments };
  }

  /** Create YouTube broadcast on permanent ingest; never creates a stream unless explicitly allowed. */
  async _createYoutubeBroadcast(o, layout, { scheduledStartTime, existingStream } = {}) {
    const frameRate = liveStreamFrameRate();
    const privacy = o.privacyStatus || process.env.LIVE_GRID_PRIVACY || 'public';
    const templatePack = buildGoLiveSeo({}, {
      ...o,
      assignments: this._lastAssignments,
      streamers: this._buildSeoContext(layout).streamers,
      operatorLocks: this.operatorLocks,
      programMode: layout?.mode,
    });
    const seoCtx = templatePack.fromTemplate
      ? { streamers: templatePack.streamers, programMode: templatePack.programMode }
      : this._buildSeoContext(layout);
    const seo = templatePack.fromTemplate
      ? templatePack.seo
      : await generateGridSeo(seoCtx);
    if (templatePack.fromTemplate) {
      this.log(`go-live template SEO (${templatePack.streamers.map(s => s.login).join(', ')})`);
    } else if (seo) {
      this.log(`SEO copy generated: "${seo.title}"`);
    }
    const title = o.title || seo?.title || layout.title || gridTitle(this._lastPollerAssignments);
    const description = o.description || seo?.description ||
      `${layout.descriptionPrefix || 'The biggest live moments from the ClipzWorld roster — four streams, one grid, all live.'}\n\n${formatAudioInstructions('\n')}`;

    let streamId;
    let output;
    const ingest = resolveIngestForCreate(o, existingStream);
    if (ingest) {
      streamId = ingest.streamId;
      output = ingest.rtmpUrl;
      this.log(`reusing YouTube ingest stream ${streamId} (same RTMP key)`);
    } else {
      const stream = await yt.createLiveStream({
        title: 'ClipzWorld Live Grid landscape',
        frameRate,
        resolution: '1080p',
      });
      streamId = stream.streamId;
      output = stream.rtmpUrl;
      this.log(
        `created NEW YouTube ingest stream ${streamId} — save LIVE_GRID_RTMP_URL + LIVE_GRID_STREAM_ID to .env, ` +
        'then set LIVE_GRID_ALLOW_NEW_STREAM=off'
      );
    }
    const broadcast = await yt.createLiveBroadcast({
      title,
      description,
      privacyStatus: privacy,
      streamId,
      scheduledStartTime: scheduledStartTime || undefined,
    });
    this.broadcast = { ...broadcast, streamId };
    this.log(`landscape broadcast: ${broadcast.watchUrl}${scheduledStartTime ? ` (scheduled ${scheduledStartTime})` : ''}`);

    if (seo && (SEO_ON_START || templatePack.fromTemplate || o.createListing === true)) {
      await this._applyYoutubeSeo(seo, {
        programMode: templatePack.programMode,
        streamers: templatePack.streamers,
        skipThumbnail: false,
      }).catch(e => this.log(`YouTube SEO apply failed: ${e.message}`));
    } else if (seo) {
      this.log('YouTube SEO apply skipped (LIVE_GRID_SEO_ON_START=off — use config/live_grid_go_live.json seo for template apply)');
    }

    let verticalOutput = null;
    const { verticalOutput: presetVertical, createVerticalBroadcast, legacyDual } =
      resolveVerticalStream({ verticalOutput: o.verticalOutput });
    verticalOutput = presetVertical;

    if (!verticalOutput && createVerticalBroadcast) {
      const vPreset = process.env.LIVE_GRID_VERTICAL_STREAM_ID && process.env.LIVE_GRID_VERTICAL_OUTPUT
        ? {
          streamId: process.env.LIVE_GRID_VERTICAL_STREAM_ID,
          rtmpUrl: process.env.LIVE_GRID_VERTICAL_OUTPUT,
        }
        : null;
      if (!vPreset && !allowNewIngestStream(o)) {
        this.log(
          'legacy vertical skipped — set LIVE_GRID_VERTICAL_OUTPUT + LIVE_GRID_VERTICAL_STREAM_ID, ' +
          'or LIVE_GRID_ALLOW_NEW_STREAM=on for one-time vertical stream creation'
        );
      } else try {
        let vStreamId;
        let vRtmp;
        if (vPreset) {
          vStreamId = vPreset.streamId;
          vRtmp = vPreset.rtmpUrl;
          this.log(`reusing vertical ingest stream ${vStreamId}`);
        } else {
          const vStream = await yt.createLiveStream({
            title: 'ClipzWorld Live Grid vertical',
            frameRate,
            resolution: '1080p',
          });
          vStreamId = vStream.streamId;
          vRtmp = vStream.rtmpUrl;
          this.log(
            `created NEW vertical ingest ${vStreamId} — save LIVE_GRID_VERTICAL_* to .env, ` +
            'then set LIVE_GRID_ALLOW_NEW_STREAM=off'
          );
        }
        const vBroadcast = await yt.createLiveBroadcast({
          title: `${title.slice(0, 88)} (Vertical)`,
          description,
          privacyStatus: privacy,
          streamId: vStreamId,
          scheduledStartTime: scheduledStartTime || undefined,
        });
        verticalOutput = vRtmp;
        this.verticalBroadcast = { ...vBroadcast, streamId: vStreamId };
        this.log(`legacy dual broadcast (vertical): ${vBroadcast.watchUrl}`);
      } catch (e) {
        this.log(`legacy vertical broadcast skipped: ${e.response?.data?.error?.message || e.message}`);
      }
    } else if (!legacyDual && !presetVertical) {
      this.log('mobile portrait: YouTube native dual-format from landscape ingest (CPD-1029)');
    }

    return { output, verticalOutput, seo, title, description };
  }

  /** True when env broadcast id can be reused (not ended on YouTube). */
  async _canReuseBroadcastId(bid) {
    if (!bid) return false;
    if (!yt.isConnected()) return true;
    try {
      const st = await yt.getBroadcastStatus(bid);
      if (!st) {
        this.log(`broadcast ${bid} not found on YouTube`);
        return false;
      }
      if (st.lifeCycleStatus === 'complete') {
        this.log(`broadcast ${bid} is complete — need a fresh listing`);
        return false;
      }
      return true;
    } catch (e) {
      const status = e.response?.status;
      if (status === 404) {
        this.log(`broadcast ${bid} not found on YouTube (404)`);
        return false;
      }
      if (trustEnvBroadcast() && (status === 403 || status === 429)) {
        this.log(`broadcast status check skipped (${status}) — trusting env listing ${bid}`);
        return true;
      }
      // Transient API errors during live — trust env pin; never orphan by accidental create.
      this.log(`broadcast status check failed (${e.message}) — trusting env listing ${bid}`);
      return true;
    }
  }

  /**
   * Schedule-ahead: create YouTube broadcast + SEO/thumbnail before encoder starts.
   * Does not start ffmpeg or set running=true.
   */
  async prepare(o = {}) {
    if (this.running) throw new Error('live grid already running');
    this.opts = o || {};

    const existing = loadPrepared();
    if (existing && !preparedIsStale(existing) && !o.force) {
      this.log(`prepared broadcast already exists: ${existing.watchUrl}`);
      return {
        prepared: true,
        alreadyExists: true,
        watchUrl: existing.watchUrl,
        broadcastId: existing.broadcastId,
        scheduledStartTime: existing.scheduledStartTime,
      };
    }

    let scheduledStartTime = o.scheduledStartTime;
    if (!scheduledStartTime) {
      try {
        const { getStreamWindows } = require('../calendar/slot_jobs');
        const win = getStreamWindows().grid;
        if (win?.start != null) scheduledStartTime = gridStartIsoFromMinutes(win.start);
      } catch (_) {}
    }
    if (!scheduledStartTime) scheduledStartTime = gridStartIsoFromMinutes(18 * 60);

    const { layout } = await this._resolveLaunchLayout(o);
    const { output, verticalOutput, seo } = await this._createYoutubeBroadcast(o, layout, {
      scheduledStartTime,
      existingStream: existingIngestStream(o) || undefined,
    });

    const windowKey = o.windowKey || null;
    savePrepared({
      broadcastId: this.broadcast.broadcastId,
      watchUrl: this.broadcast.watchUrl,
      streamId: this.broadcast.streamId,
      rtmpUrl: output,
      verticalBroadcast: this.verticalBroadcast,
      verticalRtmpUrl: verticalOutput,
      scheduledStartTime,
      seo,
      windowKey,
      body: {
        privacyStatus: o.privacyStatus,
        programMode: o.programMode,
        roster: o.roster,
        eventTitle: o.eventTitle,
        eventFile: o.eventFile,
        headline: o.headline,
      },
    });

    this.log(`prepared for ${scheduledStartTime} — attach encoder at window open`);
    return {
      prepared: true,
      watchUrl: this.broadcast.watchUrl,
      broadcastId: this.broadcast.broadcastId,
      scheduledStartTime,
      rtmpUrl: output.replace(/\/live2\/.+$/, '/live2/…'),
    };
  }

  async refreshPrepared(o = {}) {
    const prep = loadPrepared();
    if (!prep || preparedIsStale(prep)) throw new Error('no valid prepared broadcast to refresh');

    this.opts = { ...(prep.body || {}), ...o, force: true };
    await this._resolveLaunchLayout(this.opts);
    const seo = await generateGridSeo(this._buildSeoContext());
    if (!seo) throw new Error('SEO generation failed');

    this.broadcast = {
      broadcastId: prep.broadcastId,
      watchUrl: prep.watchUrl,
      streamId: prep.streamId,
    };
    await yt.updateBroadcastMeta(prep.broadcastId, {
      title: seo.title,
      description: seo.description,
      scheduledStartTime: prep.scheduledStartTime,
    });
    await this._applyYoutubeSeo(seo);

    savePrepared({
      ...prep,
      seo,
      body: this.opts,
    });
    this.log(`refreshed prepared broadcast SEO/thumbnail for ${prep.scheduledStartTime}`);
    return {
      refreshed: true,
      watchUrl: prep.watchUrl,
      scheduledStartTime: prep.scheduledStartTime,
      title: seo.title,
    };
  }

  /** Hot daypart switch while live — no RTMP restart. */
  async setProgramMode(mode, opts = {}) {
    if (!this.running) throw new Error('live grid not running');
    if (!mode) throw new Error('mode required');
    if (opts.fileOverrides || opts.headline) {
      this.programDirector.setOverrides({
        fileOverrides: opts.fileOverrides,
        headline: opts.headline,
      });
    }
    this.programDirector.mode = mode;
    this.opts.programMode = mode;
    const layout = await this._applyProgram(this._lastPollerAssignments);
    this._applySourceLayout(layout, this._programLayout?.sources || []);
    this.log(`program mode hot-switch → ${layout.mode}`);
    if (this.broadcast) {
      await this._applyYoutubeSeoFromLayout(layout)
        .catch(e => this.log(`YouTube SEO update failed: ${e.message}`));
    }
    this._syncAvatarPip(layout);
    return {
      mode: layout.mode,
      modeLabel: layout.modeLabel,
      title: layout.title,
    };
  }

  async start(o = {}) {
    if (this.running) throw new Error('live grid already running');
    o = applyGoLiveDefaults(o || {});
    this.running = true;
    this.startedAt = Date.now();
    this.opts = o;

    this._stickTemplateLocks = !!o._stickTemplateLocks;

    await new Promise((res, rej) => generateSlate(e => e ? rej(e) : res()));

    const { layout, assignments } = await this._resolveLaunchLayout(o);
    this.feeders = new QuadrantFeeders({ log: this.log });
    this.feeders.onFeedUnhealthy = (q, info) => this._onFeedUnhealthy(q, info);
    this.feeders.onChannelOffline = (q, login) => {
      this._onChannelWentOffline(q, login).catch((e) => this.log(`offline replace failed Q${q + 1}: ${e.message}`));
    };
    this.feeders.onFeederLive = (q, login) => {
      this.swapController?.onFeederLive(q, login);
    };
    const resumeRuntime = o._resumeRuntime;
    if (resumeRuntime?.operatorLocks?.length) {
      if (resumeRuntime.operatorMode) this.poller.operatorMode = true;
      else if (o.operatorMode === false) this.poller.operatorMode = false;
      const { applyResumeRuntime } = require('./resume_state');
      applyResumeRuntime(this, resumeRuntime);
      this._programLayout = await this._applyProgram(assignments);
      this._lastAssignments = this._sourcesToLogins(this._programLayout.sources);
    } else {
      this.feeders.applySources(layout.sources);
      this._programLayout = layout;
      this._lastAssignments = this._sourcesToLogins(layout.sources);
    }
    if (o.autoPilot === true || o.operatorMode === false) {
      this.poller.operatorMode = false;
      this.operatorLocks = [null, null, null, null];
    }

    let output = o.output || process.env.LIVE_GRID_RTMP_URL || process.env.YOUTUBE_LIVE_RTMP_URL || null;
    const { resolveLocalPreviewConfig } = require('./local_preview');
    const localPreview = resolveLocalPreviewConfig();
    this._localPreview = localPreview;
    const forceLocalOnly = o.localOnly === true || localPreview.localOnly;

    if (forceLocalOnly) {
      output = localPreview.hlsPath;
      this.broadcast = {
        broadcastId: null,
        watchUrl: localPreview.watchPageUrl,
        hlsUrl: localPreview.hlsUrl,
        localOnly: true,
      };
      this.log(`LOCAL ONLY — composed grid → ${localPreview.hlsPath} (no YouTube RTMP)${o.localOnly ? ' [rehearsal]' : ''}`);
    }
    const { verticalOutput: presetVertical, createVerticalBroadcast, legacyDual } =
      resolveVerticalStream({ verticalOutput: o.verticalOutput });
    let verticalOutput = presetVertical;

    if (!forceLocalOnly) {
      if (!output) {
        let consumedPrepared = null;
        if (o.usePrepared !== false && scheduleAheadEnabled()) {
          const prep = loadPrepared();
          if (prep && !preparedIsStale(prep)) {
            if (o.usePrepared === true && !scheduledStartReady(prep)) {
              throw new Error(`prepared broadcast not ready until ${prep.scheduledStartTime}`);
            }
            consumedPrepared = prep;
          } else if (o.usePrepared === true) {
            throw new Error('no prepared broadcast — run /live-grid/prepare first');
          }
        }

        if (consumedPrepared) {
          output = consumedPrepared.rtmpUrl;
          this.broadcast = {
            broadcastId: consumedPrepared.broadcastId,
            watchUrl: consumedPrepared.watchUrl,
            streamId: consumedPrepared.streamId,
          };
          if (consumedPrepared.verticalRtmpUrl) {
            verticalOutput = consumedPrepared.verticalRtmpUrl;
            this.verticalBroadcast = consumedPrepared.verticalBroadcast;
          }
          clearPrepared();
          this.log(`using prepared broadcast: ${consumedPrepared.watchUrl}`);
        } else {
          const created = await this._createYoutubeBroadcast(o, layout);
          output = created.output;
          if (created.verticalOutput) verticalOutput = created.verticalOutput;
        }
      } else {
        const attach = envBroadcastAttach(o);
        const { loadDeadBroadcastIds } = require('./youtube_listing_env');
        const dead = loadDeadBroadcastIds();
        const bidRaw = (o.broadcastId || process.env.LIVE_GRID_BROADCAST_ID || attach?.broadcastId || '').trim() || null;
        const bid = bidRaw && !dead.has(bidRaw) ? bidRaw : null;
        const ingest = existingIngestStream(o);
        const studioAttach = (o.createListing === false || (trustEnvBroadcast() && o.createListing !== true))
          && !!bid && !!attach;
        const wantFresh = o.freshListing === true
          || (ALWAYS_FRESH_LISTING && ingest && yt.isConnected() && !trustEnvBroadcast());

        if (wantFresh && ingest) {
          if (bidRaw) {
            try {
              await yt.endLiveBroadcast(bidRaw);
              this.log(`ended listing ${bidRaw} — fresh listing on same RTMP key`);
            } catch (e) {
              this.log(`end listing ${bidRaw} skipped: ${e.response?.data?.error?.message || e.message}`);
            }
          }
          const created = await this._createYoutubeBroadcast(o, layout, { existingStream: ingest });
          output = created.output;
          if (created.verticalOutput) verticalOutput = created.verticalOutput;
          this.log(`fresh listing → ${this.broadcast?.watchUrl}`);
        } else if (studioAttach && attach && trustEnvBroadcast()) {
          const canReuse = await this._canReuseBroadcastId(bid);
          if (canReuse) {
            this.broadcast = {
              broadcastId: attach.broadcastId,
              watchUrl: attach.watchUrl,
              streamId: attach.streamId,
            };
            output = attach.rtmpUrl;
            this.log(`YouTube attach (env listing verified) → ${attach.watchUrl}`);
          } else if (ingest && yt.isConnected()) {
            const created = await this._createYoutubeBroadcast(o, layout, { existingStream: ingest });
            output = created.output;
            if (created.verticalOutput) verticalOutput = created.verticalOutput;
            this.log(`env listing ${bidRaw} not reusable — fresh listing → ${this.broadcast?.watchUrl}`);
          } else {
            throw new Error(
              `YouTube listing ${bidRaw} is not reusable — connect YouTube API or set a fresh listing in Studio`
            );
          }
        } else if (ingest && yt.isConnected()) {
          const canReuse = bid ? await this._canReuseBroadcastId(bid) : false;
          const forceNew = o.freshListing === true || ALWAYS_FRESH_LISTING;

          if (canReuse && !forceNew) {
            this.broadcast = {
              broadcastId: bid,
              watchUrl: o.watchUrl || process.env.LIVE_GRID_WATCH_URL || `https://youtube.com/live/${bid}`,
              streamId: ingest.streamId,
            };
            output = ingest.rtmpUrl;
            this.log(`reusing YouTube listing ${bid} — no new API listing created`);
          } else {
            const created = await this._createYoutubeBroadcast(o, layout, { existingStream: ingest });
            output = created.output;
            if (created.verticalOutput) verticalOutput = created.verticalOutput;
            this.log(`new YouTube listing → ${this.broadcast?.watchUrl}`);
          }
        } else {
          const canReuse = bid ? await this._canReuseBroadcastId(bid) : false;
          if (canReuse) {
            this.broadcast = {
              broadcastId: bid,
              watchUrl: o.watchUrl || process.env.LIVE_GRID_WATCH_URL || `https://youtube.com/live/${bid}`,
              streamId: o.streamId || process.env.LIVE_GRID_STREAM_ID || null,
            };
            this.log(`reusing YouTube broadcast ${bid}${output && !o.output ? ' (env RTMP — API bypass)' : ''}`);
          } else if (bid && yt.isConnected()) {
            throw new Error(
              `YouTube listing ${bid} not attachable — click GO LIVE again (API will create a fresh listing)`
            );
          } else if (bid) {
            this.broadcast = {
              broadcastId: bid,
              watchUrl: o.watchUrl || process.env.LIVE_GRID_WATCH_URL || `https://youtube.com/live/${bid}`,
              streamId: o.streamId || process.env.LIVE_GRID_STREAM_ID || null,
            };
            this.log(`reusing YouTube broadcast ${bid} (no API — YouTube not connected)`);
          } else if (ingest) {
            throw new Error('YouTube OAuth not connected — connect YouTube on Broadcast page, then GO LIVE');
          } else {
            throw new Error(
              'YouTube ingest not configured — set LIVE_GRID_RTMP_URL + LIVE_GRID_STREAM_ID in .env'
            );
          }
        }
      }
    }

    if (this.broadcast?.broadcastId && !this.broadcast.localOnly) {
      try {
        const { persistYoutubeListing } = require('./youtube_listing_env');
        persistYoutubeListing({
          broadcastId: this.broadcast.broadcastId,
          watchUrl: this.broadcast.watchUrl,
          streamId: this.broadcast.streamId,
        });
        this.log(`YouTube listing saved to .env → ${this.broadcast.broadcastId}`);
      } catch (e) {
        this.log(`YouTube listing env sync failed: ${e.message}`);
        throw e;
      }
      this._requestedPrivacy = o.privacyStatus || process.env.LIVE_GRID_PRIVACY || 'public';
      await this._applyListingPrivacy(this._requestedPrivacy);
    }

    if (process.env.RENDER && this.broadcast?.watchUrl && !this.broadcast.localOnly) {
      try {
        const { applyYoutubeOutputDims } = require('./render_profile');
        const aspect = applyYoutubeOutputDims(this.broadcast.watchUrl, (m) => this.log(m));
        if (aspect.probe && !aspect.probe.error) {
          this._youtubeDeliveryAspect = aspect.probe;
        }
      } catch (e) {
        this.log(`YouTube aspect apply skipped: ${e.message}`);
      }
    }

    if (verticalOutput) {
      this.log(`legacy 9:16 ffmpeg encode → ${verticalOutput.replace(/\/live2\/.+$/, '/live2/…')}`);
    }

    this.relays = USE_UDP_RELAY ? new QuadRelays({ log: this.log }) : null;

    this.audioQuad = this._autoAudioQuad(assignments);
    let avatarOverlay = resolveAvatarOverlay(this._pipOverlayOpts(this._programLayout, o));
    if (avatarOverlay) this.log(`avatar PIP: ${path.basename(avatarOverlay)}`);
    else if (shouldUseAvatarPip(this._programLayout.mode, this._pipOverlayOpts(this._programLayout, o)) === false && String(process.env.LIVE_GRID_AVATAR_PIP || 'auto').toLowerCase() !== 'off') {
      this.log(`avatar PIP off (${this._programLayout.mode} — co-stream quadrants must stay clear)`);
    }
    this._avatarOverlayPath = avatarOverlay;
    this._fallbackMusicPath = fallbackMusicEnabled() ? resolveFallbackBedPath() : null;
    const embedBed = String(process.env.LIVE_GRID_EMBED_MUSIC_BED || 'off').toLowerCase() === 'on';
    const bedForCompositor = embedBed ? this._fallbackMusicPath : null;
    if (this._fallbackMusicPath && bedForCompositor) {
      this.log(`fallback music bed embedded in encoder: ${path.basename(this._fallbackMusicPath)}`);
    } else if (this._fallbackMusicPath) {
      this.log(`fallback music bed available (not embedded — avoids ffmpeg decode lag; mute-only protect)`);
    }
    const deliveryRtmp = !!(output && /^rtmps?:/.test(output));
    const useOutputMiddleware = outputMiddlewareEnabled() && deliveryRtmp && !forceLocalOnly;
    this._rtmpDeliveryUrl = useOutputMiddleware ? output : null;
    this._middlewareFlags = middlewareStatus();

    let compositorOutput = output;
    let compositorLocalHls = null;

    if (useOutputMiddleware) {
      compositorOutput = localPreview.hlsPath;
      this.log(`OUTPUT MIDDLEWARE — compositor → ${compositorOutput}; restreamer → YouTube RTMP`);
    } else if (localPreview.hlsEnabled && deliveryRtmp && !forceLocalOnly) {
      compositorLocalHls = localPreview.hlsPath;
      this.log(`local HLS tap → ${localPreview.hlsUrl} (same encode as RTMP — for localhost QA)`);
    } else if (forceLocalOnly && output && String(output).endsWith('.m3u8')) {
      this.log(`local HLS direct → ${localPreview.hlsUrl} (rehearsal — no YouTube)`);
    }

    if (stagedSwapEnabled()) {
      this.swapController = new SwapController({
        log: (m) => this.log(`[swap] ${m}`),
        onRequestReplace: (q, login) => this._stagedSwapReplace(q, login),
        onSwapComplete: (q, login) => this._onSwapComplete(q, login),
      });
      this.log(`STAGED SWAP — debounced offline replace (${this._middlewareFlags.swapDebounceMs}ms)`);
    }

    const rtmpGuardOutput = useOutputMiddleware ? this._rtmpDeliveryUrl : compositorOutput;
    await this._guardRtmpLandscapeEncode(rtmpGuardOutput, compositorLocalHls);
    if (resumeRuntime?.operatorLocks?.length) {
      await new Promise((r) => setTimeout(r, 6000));
    }
    this.master = new MasterCompositor({
      output: compositorOutput,
      localHlsPath: compositorLocalHls,
      verticalOutput,
      logoPath: o.logoPath,
      avatarOverlay,
      fallbackMusicPath: bedForCompositor,
      fallbackMusicVolume: BED_VOLUME,
      log: this.log,
      audioQuad: this.audioQuad,
    });
    await new Promise(r => setTimeout(r, resumeRuntime?.operatorLocks?.length ? 3000 : 8000));
    if (this.relays) {
      this.relays.startAll();
      const relayWait = await this.relays.waitForRunning({ minRunning: 4, timeoutMs: 45000 });
      if (!relayWait.ready) {
        this.log(`only ${relayWait.running}/4 UDP relays up — starting master with backoff`);
      }
    }
    const { shouldHoldRtmpForStudio, studioDualInstructions } = require('./studio_dual');
    const holdRtmp = shouldHoldRtmpForStudio(o, {
      forceLocalOnly,
      broadcast: this.broadcast,
    });
    if (holdRtmp) {
      this._rtmpHeld = true;
      this._studioDual = studioDualInstructions(this.broadcast);
      this._studioDual.steps.forEach((step) => this.log(`[STUDIO DUAL] ${step}`));
      this.log(`[STUDIO DUAL] ${this._studioDual.summary}`);
    } else {
      await this._startMasterEncoder();
    }

    this.poller.on('poll', ({ assignments: next, live }) => {
      this._onAssignments(next);
      try {
        const { recordLiveGridPoll } = require('../creator_registry');
        recordLiveGridPoll({ live: live || {}, assignments: next || [] });
      } catch (_) { /* non-fatal */ }
    });
    this.poller.on('swap', (swap) => {
      if (!swap?.in) return;
      try {
        const { recordLiveGridStream } = require('../creator_registry');
        recordLiveGridStream(swap.in, { reason: swap.reason || 'swap' });
      } catch (_) { /* non-fatal */ }
    });
    this.poller.on('error', (err) => this.log(`poller error (grid unchanged): ${err.message}`));
    this.poller.start();

    this._programTick = setInterval(() => this._onProgramTick(), PROGRAM_TICK_MS);
    this._programTick.unref?.();

    if (this.broadcast) {
      try {
        this.chat = new ChatControl({
          broadcastId: this.broadcast.broadcastId,
          log: this.log,
          announceText: AUDIO_INSTRUCTIONS,
        });
        await this.chat.start();
        this.chat.on('command', (cmd) => this._onChatCommand(cmd));

        if (String(process.env.LIVE_GRID_LIKES_MILESTONE || '50').toLowerCase() !== 'off') {
          this.likeTracker = new LikeTracker({
            videoId: this.broadcast.broadcastId,
            log: this.log,
            postMessage: (t) => this.chat.postMessage(t),
            onMilestone: (count) => {
              this._swapUnlocked = true;
              this.log(`swap perk unlocked at ${count} likes`);
            },
          });
          this.likeTracker.start();
        }

        const { soloStreamsEnabled } = require('./solo_listings_env');
        if (soloStreamsEnabled()) {
          const { createSoloAnnouncer } = require('./solo_announce');
          const { readSoloListings } = require('./solo_listings_env');
          this._soloAnnouncer = createSoloAnnouncer({
            log: this.log,
            postMessage: (t) => this.chat.postMessage(t),
            getSnapshot: () => ({
              running: this.running,
              assignments: this._lastAssignments,
              mainWatchUrl: this.broadcast?.watchUrl || null,
              solos: readSoloListings(),
            }),
          });
        }
      } catch (e) {
        this.log(`chat control unavailable: ${e.message}`);
      }
    }

    this.musicDetector = new MusicDetector({
      getAssignments: () => this._lastAssignments,
      onFlags: (flags) => this._onMusicFlags(flags),
      log: this.log,
    });
    this.musicDetector.start();

    if (this.broadcast?.broadcastId) {
      this.youtubeSync = new YoutubeBroadcastSync({
        getBroadcastId: () => this.broadcast?.broadcastId || null,
        isRunning: () => this.running,
        onStale: async (reason) => {
          this.log(`YouTube sync auto-stop (${reason})`);
          await this.stop({ skipEndBroadcast: true });
          if (this.onAutoStop) await this.onAutoStop(reason);
        },
        onStatus: (info) => { this._youtubeStatus = info; },
        log: this.log,
      });
      this.youtubeSync.start();
    }

    if (process.platform === 'darwin') {
      this.caffeinate = spawn('caffeinate', ['-dims'], { stdio: 'ignore' });
    }
    this.log('live grid started');
    if (this.poller?.operatorMode) {
      this._lockCurrentGridAsOperator();
    } else if (this.poller) {
      for (let q = 0; q < 4; q++) this.poller.clearPin(q);
      this.log('auto pilot — poller pins cleared on start');
    }
    const goLiveCfg = loadGoLiveConfig();
    const shouldApplySeo = SEO_ON_START || goLiveCfg?.seo || o.createListing === true;
    if (this.broadcast?.broadcastId && this._programLayout && shouldApplySeo) {
      await this._applyYoutubeSeoAfterLaunch()
        .catch(e => this.log(`YouTube SEO on start failed: ${e.message}`));
    } else if (this.broadcast?.broadcastId && !shouldApplySeo) {
      this.log('YouTube SEO on start skipped (LIVE_GRID_SEO_ON_START=off — edit title/description in Studio)');
    }
    this._scheduleYoutubeAspectCheck();
    if (o.goPublicAt && this.broadcast?.broadcastId) {
      this._scheduleGoPublic(o.goPublicAt);
    }

    if (this.broadcast?.broadcastId && this._rtmpEncoderStarted && !this.broadcast.localOnly) {
      try {
        const { markWasLive } = require('./was_live_env');
        markWasLive();
      } catch (_) {}
      const { goLiveWaitEnabled, waitForYoutubeLive } = require('./youtube_go_live');
      if (goLiveWaitEnabled()) {
        this._youtubeGoLiveWait = await waitForYoutubeLive(this.broadcast.broadcastId, {
          log: (m) => this.log(m),
        });
      }
    }

    const st = this.status();
    if (this._youtubeGoLiveWait) st.youtubeGoLiveWait = this._youtubeGoLiveWait;
    return st;
  }

  /** Start RTMP after YouTube Studio dual-format is configured (CPD-1029). */
  async startRtmp() {
    if (!this.running) throw new Error('live grid not running');
    if (!this._rtmpHeld) {
      return { ok: true, already: true, message: 'RTMP encoder already running' };
    }
    await this._applyListingPrivacy();
    await this._startMasterEncoder();
    try {
      const { saveResumeFromManager } = require('./resume_state');
      saveResumeFromManager(this);
    } catch (_) {}
    return { ok: true, started: true, status: this.status() };
  }

  /** Login for solo seat SEO — use live feeder assignment (matches /live-grid/status quadrants). */
  _feederLogins() {
    return (this.feeders?.status() || []).map((f) => (
      normalizeSoloLogin(f?.login) || normalizeSoloLogin(f?.channelSlug) || null
    ));
  }

  _streamersFromFeeders() {
    const live = this.poller?.lastLive || {};
    return (this.feeders?.status() || [])
      .map((f, i) => {
        const login = normalizeSoloLogin(f?.login) || normalizeSoloLogin(f?.channelSlug);
        if (!login) return null;
        return {
          login,
          displayName: f.displayName || displayName(login),
          viewers: live[login] || 0,
          role: 'co-stream',
          quadrant: i + 1,
        };
      })
      .filter(Boolean);
  }

  _resolveSoloLogin(q, listing) {
    const feeder = this.feeders?.status()?.[q];
    const fromFeeder = normalizeSoloLogin(feeder?.login) || normalizeSoloLogin(feeder?.channelSlug);
    if (fromFeeder) return fromFeeder;
    const fromGrid = normalizeSoloLogin(this._lastAssignments?.[q]);
    if (fromGrid) return fromGrid;
    const fromLabel = normalizeSoloLogin(listing?.label);
    if (fromLabel) return fromLabel;
    return null;
  }

  /** Push title/description/tags to an existing solo YouTube broadcast (never creates listings). */
  async _applySoloYoutubeSeo(q, broadcastId, login, seoOpts = {}) {
    const mainUrl = this.broadcast?.watchUrl || process.env.LIVE_GRID_MAIN_WATCH_URL || '';
    const gridLogins = this._feederLogins().length ? this._feederLogins() : (this._lastAssignments || []);
    const seo = buildSoloLiveSeo({
      login,
      quadrant: q,
      mainWatchUrl: mainUrl,
      gridLogins,
    });
    const playlistId = yt.resolveLivePlaylistIdFromConfig?.() || null;
    const result = await yt.applyLiveBroadcastSeo(broadcastId, seo, {
      log: (m) => this.log(`solo Q${q + 1}: ${m}`),
      playlistId: playlistId || undefined,
      membersOnlyChat: true,
      setPublic: seoOpts.setPublic,
    });
    if (result.tags) this.log(`solo Q${q + 1} YouTube tags set (${seo.tags?.length || 0})`);
    return { seo, result };
  }

  async _prepareSoloBroadcasts({ allowCreate = false } = {}) {
    const {
      readSoloListingForQuadrant,
      persistSoloListing,
      soloCreateBroadcastsEnabled,
    } = require('./solo_listings_env');
    if (!yt.isConnected()) {
      this.log('solo broadcast prep skipped — YouTube API not connected');
      return [];
    }
    const mayCreate = allowCreate === true || (allowCreate == null && soloCreateBroadcastsEnabled());
    const privacy = this._requestedPrivacy || process.env.LIVE_GRID_PRIVACY || 'public';
    const prepared = [];
    for (let q = 0; q < 4; q++) {
      const listing = readSoloListingForQuadrant(q);
      if (!listing?.rtmpUrl || !listing.streamId) continue;
      const login = this._resolveSoloLogin(q, listing);
      if (!login) {
        prepared.push({ quadrant: q + 1, broadcastId: listing?.broadcastId, error: 'no streamer login for quadrant' });
        continue;
      }
      let bid = listing.broadcastId;
      const reusable = bid ? await this._canReuseBroadcastId(bid) : false;
      if (!reusable) {
        if (!mayCreate) {
          if (!bid) {
            this.log(`solo Q${q + 1} missing LIVE_GRID_SOLO_${q + 1}_BROADCAST_ID — set via Studio or POST /live-grid/solo-listings`);
            prepared.push({ quadrant: q + 1, error: 'no broadcastId in env' });
            continue;
          }
          this.log(`solo Q${q + 1} broadcast ${bid} not active on YouTube — SEO-only (no new listing). Fix env ID or POST /live-grid/refresh-all-seo with soloBroadcastIds`);
        } else {
          const seoPreview = buildSoloLiveSeo({ login, quadrant: q, gridLogins: this._feederLogins(), mainWatchUrl: this.broadcast?.watchUrl });
          const broadcast = await yt.createLiveBroadcast({
            title: seoPreview.title,
            description: seoPreview.description,
            privacyStatus: privacy,
            streamId: listing.streamId,
          });
          persistSoloListing(q, {
            broadcastId: broadcast.broadcastId,
            watchUrl: broadcast.watchUrl,
            streamId: listing.streamId,
            rtmpUrl: listing.rtmpUrl,
            label: listing.label,
          });
          bid = broadcast.broadcastId;
          this.log(`solo Q${q + 1} fresh broadcast → ${broadcast.watchUrl}`);
        }
      } else {
        this.log(`solo Q${q + 1} reusing broadcast ${bid}`);
      }
      try {
        const { seo } = await this._applySoloYoutubeSeo(q, bid, login);
        prepared.push({ quadrant: q + 1, broadcastId: bid, login, title: seo.title });
      } catch (e) {
        this.log(`solo Q${q + 1} SEO failed: ${e.message}`);
        prepared.push({ quadrant: q + 1, broadcastId: bid, login, seoError: e.message });
      }
    }
    return prepared;
  }

  /** Regenerate + push YouTube title/description/tags for all solo seat broadcasts. */
  async refreshSoloYoutubeSeo(opts = {}) {
    if (!yt.isConnected()) return { refreshed: false, reason: 'YouTube API not connected' };
    this._syncAssignmentsFromFeeders();
    const { readSoloListingForQuadrant, resolveSoloBroadcastIdFromMap } = require('./solo_listings_env');
    const idMap = opts.soloBroadcastIds || opts.broadcastIds;
    this.log('YouTube solo SEO refresh');
    const seats = [];
    for (let q = 0; q < 4; q++) {
      const listing = readSoloListingForQuadrant(q);
      const bid = resolveSoloBroadcastIdFromMap(q, idMap, listing?.broadcastId);
      if (!bid) continue;
      const login = this._resolveSoloLogin(q, listing);
      if (!login) {
        seats.push({ quadrant: q + 1, broadcastId: bid, error: 'no streamer login for quadrant' });
        continue;
      }
      try {
        const { seo, result } = await this._applySoloYoutubeSeo(q, bid, login, { setPublic: opts.setPublic });
        seats.push({
          quadrant: q + 1,
          broadcastId: bid,
          title: seo.title,
          tags: result.tags,
          playlist: result.playlist,
          channelKeywords: result.channelKeywords,
          chatPolicy: result.chatPolicy,
        });
      } catch (e) {
        seats.push({ quadrant: q + 1, broadcastId: bid, error: e.message });
      }
    }
    return { refreshed: seats.length > 0, seats };
  }

  /** CPD-1047 — start four per-seat solo RTMP publishers (after main YouTube is live). */
  async startSoloStreams({ allowCreateBroadcasts = false } = {}) {
    if (!this.running) throw new Error('live grid not running');
    const { soloStreamsConfigured, soloStreamsEnabled } = require('./solo_listings_env');
    if (!soloStreamsEnabled()) throw new Error('LIVE_GRID_SOLO_STREAMS=off');
    if (!soloStreamsConfigured()) throw new Error('no solo RTMP URLs configured (LIVE_GRID_SOLO_N_RTMP_URL)');
    await this._prepareSoloBroadcasts({ allowCreate: allowCreateBroadcasts === true });
    if (this.soloPublishers?.started) {
      this.soloPublishers.stopAll();
    }
    if (!this.soloPublishers) {
      const { SoloPublishers } = require('./solo_publishers');
      this.soloPublishers = new SoloPublishers({
        log: (m) => this.log(m),
        relayReady: (q) => !!(this.relays?.procs?.[q]),
      });
    }
    this.soloPublishers.startAll();
    this._soloAnnouncer?.schedule();
    return { ok: true, started: true, solos: this._soloStatusSeats() };
  }

  _soloStatusSeats() {
    const { readSoloListingForQuadrant } = require('./solo_listings_env');
    if (this.soloPublishers?.started) {
      return this.soloPublishers.status((q) => this._lastAssignments[q]);
    }
    return [0, 1, 2, 3].map((q) => {
      const listing = readSoloListingForQuadrant(q);
      const login = this._resolveSoloLogin(q, listing);
      return {
        quadrant: q + 1,
        login: login || null,
        running: false,
        restarts: 0,
        watchUrl: listing?.watchUrl || null,
        broadcastId: listing?.broadcastId || null,
        label: listing?.label || `Screen ${q + 1}`,
        configured: !!listing?.rtmpUrl,
      };
    });
  }

  async _startMasterEncoder() {
    if (this._rtmpEncoderStarted) return { already: true };
    await this._refreshGridAvatars();
    this.master.start();
    if (this._rtmpDeliveryUrl && outputMiddlewareEnabled()) {
      const localPreview = this._localPreview || require('./local_preview').resolveLocalPreviewConfig();
      this.restreamer = new GridRestreamer({
        hlsPath: localPreview.hlsPath,
        rtmpUrl: this._rtmpDeliveryUrl,
        log: (m) => this.log(m),
      });
      await this.restreamer.start();
      this.log('grid restreamer attached → YouTube delivery decoupled from compositor');
    }
    this._rtmpEncoderStarted = true;
    this._rtmpHeld = false;
    this._studioDual = null;
    this.log('RTMP encoder started → YouTube');
    this._scheduleSoloAutoStart();
    return { started: true };
  }

  _soloWaitYoutubeLiveEnabled() {
    return String(process.env.LIVE_GRID_SOLO_WAIT_YOUTUBE_LIVE ?? 'on').toLowerCase() !== 'off';
  }

  _scheduleSoloAutoStart() {
    const auto = String(process.env.LIVE_GRID_SOLO_AUTO_START ?? 'on').toLowerCase() !== 'off';
    if (!auto) return;
    try {
      const { soloStreamsEnabled, soloStreamsConfigured } = require('./solo_listings_env');
      if (!soloStreamsEnabled() || !soloStreamsConfigured()) return;
      if (this.soloPublishers?.started) return;
    } catch (e) {
      this.log(`solo auto-start skipped: ${e.message}`);
      return;
    }
    clearTimeout(this._soloAutoStartTimer);
    this._soloAutoStartTimer = setTimeout(() => {
      this._soloAutoStartTimer = null;
      this._tryStartSoloStreamsWhenReady().catch((e) => {
        this.log(`solo auto-start failed: ${e.message}`);
      });
    }, 0);
    this._soloAutoStartTimer.unref?.();
  }

  async _tryStartSoloStreamsWhenReady() {
    if (!this.running || this.soloPublishers?.started) return;
    const { soloStreamsEnabled, soloStreamsConfigured } = require('./solo_listings_env');
    if (!soloStreamsEnabled() || !soloStreamsConfigured()) return;

    if (this._soloWaitYoutubeLiveEnabled() && this.broadcast?.broadcastId && !this.broadcast.localOnly) {
      const pollMs = Math.max(3000, parseInt(process.env.LIVE_GRID_SOLO_YOUTUBE_POLL_MS || '10000', 10));
      const timeoutMs = Math.max(60000, parseInt(process.env.LIVE_GRID_SOLO_YOUTUBE_WAIT_MS || '300000', 10));
      const waitStarted = Date.now();
      let mainLive = false;
      this.log('solo auto-start waiting for main YouTube live…');
      while (this.running && !mainLive && Date.now() - waitStarted < timeoutMs) {
        try {
          const info = await this.youtubeSync?.probe?.();
          if (info?.liveOnYouTube) {
            mainLive = true;
            this.log(`main YouTube live (${info.lifeCycleStatus}) — starting solo streams`);
            break;
          }
        } catch (_) {}
        await new Promise((r) => setTimeout(r, pollMs));
      }
      if (!mainLive) {
        this.log('solo auto-start timeout — main not live yet; use POST /live-grid/solo-go when ready');
        return;
      }
    }

    if (!this.running || this.soloPublishers?.started) return;
    const result = await this.startSoloStreams({ allowCreateBroadcasts: false });
    this.log(`solo streams auto-started (${result.solos?.filter((s) => s.configured).length || 0} seats)`);
  }

  /** Block GO LIVE when RTMP plan would square-pad a landscape grid (LOCAL_HLS + SQUARE_PAD). */
  _guardRtmpLandscapeEncode(output, localHlsPath) {
    if (this.broadcast?.localOnly) return;
    const { checkRtmpLandscapeEncode } = require('./rtmp_landscape_guard');
    const { describeEncodePlan } = require('./compositor');
    const plan = describeEncodePlan({ output, localHlsPath });
    this._rtmpEncodePlan = plan;
    this.log(`RTMP plan: ${plan.rtmp}${plan.localHls ? ` | local HLS ${plan.localHls}` : ''} | cell=${plan.cellFit} | enc=${plan.encoder}`);
    if (this.broadcast?.streamId) {
      this.log(`YouTube ingest stream ${this.broadcast.streamId}`);
    }
    const r = checkRtmpLandscapeEncode({
      output,
      localHlsPath,
      streamId: this.broadcast?.streamId || null,
    });
    if (!r.ok) {
      this.log(`[RTMP ASPECT] ${r.error}`);
      this.log(`[RTMP ASPECT] FIX: ${r.fix}`);
      throw new Error(r.error);
    }
  }

  /** Warn when YouTube CDN is square (Dual stream) while local HLS is 16:9 landscape. */
  _scheduleYoutubeAspectCheck() {
    const watchUrl = this.broadcast?.watchUrl;
    const hlsPath = this._localPreview?.hlsPath;
    if (!watchUrl || String(process.env.LIVE_GRID_YOUTUBE_ASPECT_CHECK || 'on').toLowerCase() === 'off') return;
    const t = setTimeout(() => {
      if (!this.running) return;
      try {
        const { checkLiveAspect } = require('./youtube_aspect_check');
        const r = checkLiveAspect({ watchUrl, hlsPath });
        if (r.local?.width) this.log(`aspect local HLS: ${r.local.width}×${r.local.height} ${r.local.dar || ''}`.trim());
        if (r.youtube?.width) this.log(`aspect YouTube CDN: ${r.youtube.width}×${r.youtube.height}`);
        if (!r.ok) {
          this.log(`[YOUTUBE ASPECT] ${r.issue}`);
          this.log(`[YOUTUBE ASPECT] FIX: ${r.fix}`);
        }
      } catch (e) {
        this.log(`YouTube aspect check skipped: ${e.message}`);
      }
    }, 90_000);
    t.unref?.();
  }

  _onChatCommand(cmd) {
    if (cmd.type === 'swap') {
      this._handleMemberSwap(cmd).catch(e => this.log(`member swap failed: ${e.message}`));
      return;
    }
    const quadKind = this.feeders?.quads[cmd.quadrant]?.kind;
    if (!this._lastAssignments[cmd.quadrant] && quadKind !== 'url' && quadKind !== 'file') {
      this.log(`chat !listen Q${cmd.quadrant + 1} ignored — quadrant is slate`);
      return;
    }

    // Dashboard manual pin blocks auto-follower only — subscriber !listen always wins.
    if (this.audioMode === 'manual' && !cmd.isMember) return;

    // CPD-1005 policy: audio is a MEMBER perk only — no public voting.
    if (MEMBER_ONLY_AUDIO && !cmd.isMember) {
      this.chat?.postMessage('⭐ Subscribe to the channel, then !listen 1-4 picks your screen instantly')
        .catch(() => {});
      return;
    }

    if (!cmd.isMember) return;

    if (Date.now() - this._lastChatSwitch < CHAT_SWITCH_COOLDOWN_MS) {
      this.log(`chat !listen Q${cmd.quadrant + 1} ignored — cooldown`);
      return;
    }
    if (this.setAudio(cmd.quadrant, 'chat')) {
      this._lastChatSwitch = Date.now();
      const name = this._audioSourceName(cmd.quadrant);
      this.log(`chat audio from @${cmd.author} quad${cmd.quadrant + 1}`);
      this.chat.postMessage(`⭐ Now hearing ${String(name).toUpperCase()} (screen ${cmd.quadrant + 1})`)
        .catch(() => {});
    }
  }

  async _handleMemberSwap({ quadrant, login, author, isMember }) {
    if (!isMember) {
      this.chat?.postMessage('⭐ !swap is for subscribers — subscribe to the channel first')
        .catch(() => {});
      return;
    }
    if (SWAP_REQUIRES_LIKES && !this._swapUnlocked) {
      this.chat?.postMessage('⭐ !swap unlocks after you subscribe and we hit the next like milestone — subscribe, like the stream, then try again!')
        .catch(() => {});
      return;
    }
    const last = this._memberSwapAt.get(author) || 0;
    if (Date.now() - last < MEMBER_SWAP_COOLDOWN_MS) {
      this.chat?.postMessage('⏳ Subscriber swap cooldown — try again later').catch(() => {});
      return;
    }
    let probe = null;
    try {
      probe = await this.poller?.probeLoginLive(login);
    } catch (e) {
      this.log(`member swap probe failed for ${login}: ${e.message}`);
    }
    if (!probe) {
      this.chat?.postMessage(`${login} isn't live right now`).catch(() => {});
      return;
    }
    login = probe.login;
    this.poller.lastLive[login] = probe.viewers;

    const roster = new Set(this.poller.roster);
    const offBench = !roster.has(login) && !this.poller.bench.has(login);
    if (offBench) {
      this.poller.updateRoster({ benchAdd: [login] });
      try {
        const { recordLiveGridStream } = require('../creator_registry');
        recordLiveGridStream(login, { reason: 'member_swap', viewers: probe.viewers });
      } catch (_) { /* non-fatal */ }
      this.log(`⚠ guest member swap: ${author} → ${login} on Q${quadrant + 1} (operator lock — wake up if needed)`);
    }

    this.setQuadrantChannel(quadrant, login);
    this._memberSwapAt.set(author, Date.now());
    this.chat?.postMessage(
      offBench
        ? `⭐ ${author} guest-swapped screen ${quadrant + 1} to ${login.toUpperCase()} — locked until offline`
        : `⭐ ${author} swapped screen ${quadrant + 1} to ${login.toUpperCase()}`
    ).catch(() => {});
  }

  _onMusicFlags(flags) {
    this._musicFlags = [...flags];
    const live = this.poller?.lastLive || {};
    const onAirMusic = flags[this.audioQuad];
    const useFallbackBed = String(process.env.LIVE_GRID_MUSIC_USE_BED || 'off').toLowerCase() === 'on';

    if (onAirMusic) {
      const unhealthy = this._quadrantHealthFlags();
      const pick = pickAudioQuad(this._lastAssignments, live, flags, { unhealthyQuads: unhealthy });
      if (pick.quad >= 0 && pick.quad !== this.audioQuad) {
        if (this.audioMode === 'manual') {
          this._musicHopManualPin = this.audioQuad;
        }
        this._clearAudioProtect();
        this.log(`🎵 music guard: hopping quad${this.audioQuad + 1} → clean quad${pick.quad + 1} (Twitch audio, no bed)`);
        this._applyAudio(pick.quad, 'music-guard');
        return;
      }
      if (pick.mute) {
        if (useFallbackBed) {
          this.log('🎵 music guard: every live quadrant flagged — copyright-safe bed');
          this._activateMusicProtect('music-guard-all-music');
        } else {
          this.log('🎵 music guard: every live quadrant flagged — muting mix (bed off)');
          this._setMuted(true, 'music-guard-all-music');
        }
      }
      return;
    }

    if (this._musicHopManualPin != null && this.audioMode === 'manual') {
      const pin = this._musicHopManualPin;
      if (!flags[pin]) {
        this._musicHopManualPin = null;
        this.log(`🎵 music guard: restoring manual pin → quad${pin + 1}`);
        this._applyAudio(pin, 'manual');
        return;
      }
    }

    if (this.audioMuted || this.fallbackMusicActive) {
      this._clearAudioProtect();
    }

    if (this.audioMode === 'manual') return;

    if (!this.audioMuted && !this.fallbackMusicActive) return;

    const pick = pickAudioQuad(this._lastAssignments, live, flags);
    if (pick.quad >= 0) {
      this._clearAudioProtect();
      if (pick.quad !== this.audioQuad) {
        this.log(`🎵 music guard: leaving quad${this.audioQuad + 1} for clean quad${pick.quad + 1}`);
        this._applyAudio(pick.quad, 'music-guard');
      }
    } else if (pick.mute && !this.audioMuted && !this.fallbackMusicActive) {
      if (useFallbackBed) {
        this.log('🎵 music guard: every live quadrant is playing music — copyright-safe audio');
        this._activateMusicProtect('music-guard-all-music');
      } else {
        this.log('🎵 music guard: every live quadrant flagged — muting mix (bed off)');
        this._setMuted(true, 'music-guard-all-music');
      }
    }
  }

  _activateMusicProtect(reason) {
    this.audioProtectReason = reason;
    const embedBed = String(process.env.LIVE_GRID_EMBED_MUSIC_BED || 'off').toLowerCase() === 'on';
    if (embedBed && this._fallbackMusicPath && this.master?.setFallbackMusic(true, { volume: BED_VOLUME })) {
      this.fallbackMusicActive = true;
      this.audioMuted = true;
      this.log(`🎵 Epidemic Sound bed ON (${path.basename(this._fallbackMusicPath)})`);
      return;
    }
    this._setMuted(true, reason);
  }

  _clearAudioProtect() {
    if (!this.audioMuted && !this.fallbackMusicActive) return;
    this.audioProtectReason = null;
    this.fallbackMusicActive = false;
    this.audioMuted = false;
    if (!this.master) return;
    if (this._fallbackMusicPath) {
      this.master.setFallbackMusic(false);
    } else {
      this.master.setMuted(false);
    }
    this.master.setAudioQuad(this.audioQuad);
    this.log('mix unmuted — Twitch audio restored');
  }

  /** Operator panic — mute Twitch mix immediately; use Epidemic bed when configured. */
  panicMute(reason = 'operator-panic') {
    this._activateMusicProtect(reason);
    return this.status().audio;
  }

  _setMuted(muted, reason = null) {
    this.audioMuted = !!muted;
    if (muted) {
      this.audioProtectReason = reason || this.audioProtectReason || 'mute';
      this.fallbackMusicActive = false;
    } else {
      this.audioProtectReason = null;
      this.fallbackMusicActive = false;
    }
    if (this.master && !this.master.setMuted(this.audioMuted)) this.master.restart();
    this.log(this.audioMuted ? `mix MUTED (${this.audioProtectReason || 'music guard'})` : 'mix unmuted');
  }

  async _onChannelWentOffline(q, login) {
    if (!this.running || !this.poller) return;
    if (this.operatorLocks[q]?.type === 'slate') return;
    const slug = String(login || '').toLowerCase();
    if (!slug) return;
    const key = `${q}:${slug}`;
    if (this._offlineReplaceAt?.[key] && Date.now() - this._offlineReplaceAt[key] < 15_000) return;
    if (!this._offlineReplaceAt) this._offlineReplaceAt = {};
    this._offlineReplaceAt[key] = Date.now();

    const current = this.poller.assignments[q];
    const lockLogin = this.operatorLocks[q]?.type === 'channel' ? this.operatorLocks[q].login : null;
    if (current !== slug && lockLogin !== slug) return;

    if (this.swapController) {
      if (restreamerHoldEnabled() && this.restreamer) this.restreamer.setHold(true);
      this.swapController.onOffline(q, slug);
      return;
    }

    this.log(`Q${q + 1} ${slug} offline at feeder — immediate replace poll`);
    await this._stagedSwapReplace(q, slug);
  }

  async _stagedSwapReplace(q, login) {
    const slug = String(login || '').toLowerCase();
    const lockLogin = this.operatorLocks[q]?.type === 'channel' ? this.operatorLocks[q].login : null;
    if (lockLogin === slug && !this._stickTemplateLocks) {
      this.operatorLocks[q] = null;
      this.poller.clearPin(q);
    }
    if (slug && this.poller.assignments[q] === slug) this.poller.assignments[q] = null;
    await this.poller.pollOnce();
  }

  _onSwapComplete(q, login) {
    if (this.restreamer) this.restreamer.setHold(false);
    this.log(`Q${q + 1} swap complete — ${login || 'slate'} on-air locally`);
    this._nudgeSoloAfterSwap(q, login);
    const delayMs = parseInt(process.env.LIVE_GRID_POST_SWAP_DELIVERY_CHECK_MS || '12000', 10);
    clearTimeout(this._postSwapDeliveryTimer);
    this._postSwapDeliveryTimer = setTimeout(() => {
      this._verifyDeliveryAfterSwap(q, login).catch((e) => {
        this.log(`post-swap delivery check failed: ${e.message}`);
      });
    }, delayMs);
    this._postSwapDeliveryTimer.unref?.();
  }

  /** Proactive — quadrant swap can stall compositor HLS; heal before viewers notice. */
  async _verifyDeliveryAfterSwap(q, login) {
    if (!this.running) return;
    const qa = this.buildDeliveryQa();
    const rsUp = this.restreamer?.status?.().running;
    if (qa.hls?.live && rsUp) return;
    this.log(`post-swap Q${q + 1} (${login || 'slate'}) delivery check: hls=${qa.hls?.live} restreamer=${rsUp} — healing`);
    await this.healDeliveryPipeline('post_swap');
  }

  _sourcesToLogins(sources) {
    return loginsFromSources(sources);
  }

  /** Keep _lastAssignments aligned with on-air feeders (URL/event seats included). */
  _syncAssignmentsFromFeeders() {
    const fromFeeders = this._feederLogins();
    if (fromFeeders.some(Boolean)) {
      this._lastAssignments = fromFeeders;
    }
  }

  _mergeOperatorLocks(sources, live = {}) {
    const out = [...(sources || [])];
    while (out.length < 4) out.push(null);
    for (let q = 0; q < 4; q++) {
      const lock = this.operatorLocks[q];
      if (!lock) continue;
      if (lock.type === 'channel') {
        if (live[lock.login] != null) {
          out[q] = lock.login;
        } else if (this._stickTemplateLocks) {
          out[q] = null;
        } else {
          this.log(`operator lock released Q${q + 1} — ${lock.login} offline`);
          this.operatorLocks[q] = null;
          this.poller?.clearPin(q);
        }
        continue;
      }
      else if (lock.type === 'url') {
        if (this._benchedFeeds?.has(lock.url)) {
          this.operatorLocks[q] = null;
          continue;
        }
        out[q] = { type: 'url', url: lock.url, label: lock.label || lock.login || '', title: lock.title || lock.login || '' };
      }       else if (lock.type === 'file') {
        out[q] = { type: 'file', path: lock.path, label: lock.label || 'CLIPZWORLD' };
      } else if (lock.type === 'slate') {
        out[q] = null;
      }
    }
    return out;
  }

  async _applyProgram(pollerAssignments) {
    if (isOperatorChannelGrid(this.operatorLocks)) {
      this.programDirector.mode = 'grid';
    }
    const pre = this.programDirector.layout(pollerAssignments);
    let feedPaths = {};
    const feedLock = this.operatorLocks[0]?.type === 'url' ? this.operatorLocks[0] : null;
    if (pre.mode === 'event_night') {
      if (feedLock) {
        const slug = feedLock.login || (feedLock.url || '').split('/').pop();
        feedPaths = {
          event_feed: {
            url: feedLock.url,
            title: feedLock.title || slug || 'Live Event',
            channel: slug || 'EVENT',
            platform: 'twitch',
            locked: true,
          },
        };
        this._eventFeed = feedPaths.event_feed;
      } else {
        const feed = await pickEventFeed({
          eventId: pre.activeEvent?.eventId,
          eventTitle: pre.activeEvent?.eventTitle,
          activeEvent: pre.activeEvent,
          explicitUrl: this.opts?.eventFeedUrl,
        });
        this._eventFeed = feed;
        if (feed?.url) feedPaths = { event_feed: feed };
      }
    } else {
      this._eventFeed = null;
    }
    const layout = this.programDirector.layout(pollerAssignments, { feedPaths });
    if (isOperatorChannelGrid(this.operatorLocks)) {
      layout.mode = 'grid';
      layout.modeLabel = this.programDirector.config?.modes?.grid?.label || layout.modeLabel;
      // Poller assignments drive sources — offline seats fill from follows/bench without overriding locks here.
    } else {
      layout.sources = this._mergeOperatorLocks(layout.sources, this.poller?.lastLive || {});
    }
    return layout;
  }

  _sourcesChanged(a, b) {
    if (!a || !b || a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) {
      const x = a[i]; const y = b[i];
      if (x === y) continue;
      if (x && y && typeof x === 'object' && typeof y === 'object') {
        if (x.type === 'file' && y.type === 'file' && x.path === y.path && x.label === y.label) continue;
        if (x.type === 'url' && y.type === 'url' && x.url === y.url && x.label === y.label) continue;
      }
      return true;
    }
    return false;
  }

  _onProgramTick() {
    if (!this.running || !this.programDirector) return;
    if (this.poller?.operatorMode) return;
    this._applyProgram(this._lastPollerAssignments)
      .then((layout) => {
        if (!this.running) return;
        if (!this._sourcesChanged(layout.sources, this._programLayout?.sources)) return;
        this.log(`program segment change → ${layout.mode}`);
        this._applySourceLayout(layout, this._programLayout?.sources || []);
      })
      .catch(e => this.log(`program tick failed: ${e.message}`));
  }

  /** Force master ffmpeg reconnect (all UDP inputs) — ~5s YouTube blip, same RTMP key. */
  refreshMasterEncoder(reason = 'operator') {
    if (!this.master?.running) return { refreshed: false, reason: 'master not running' };
    this.master.opts.audioQuad = this.audioQuad;
    this.log(`master refresh requested (${reason})`);
    this.master.restart();
    return { refreshed: true, reason };
  }

  /**
   * YouTube watch page stuck Upcoming/ready — ingest starved or stream inactive while encoder runs.
   * Refreshes master RTMP (~5s blip) instead of full grid stop.
   */
  async _maybeHealYoutubeIngest() {
    const ytApi = require('../services/youtube_direct');
    if (!ytApi.isConnected() || !this.broadcast?.broadcastId || this.broadcast.localOnly) {
      return { ok: true, action: 'none' };
    }
    const ytSnap = this._youtubeStatus || this.youtubeSync?.statusSnapshot?.() || null;
    if (ytSnap?.liveOnYouTube) return { ok: true, action: 'none' };

    const streamId = this.broadcast.streamId || process.env.LIVE_GRID_STREAM_ID;
    let health;
    try {
      health = await ytApi.getLiveStreamHealth(streamId);
    } catch (e) {
      this.log(`YouTube ingest health check failed: ${e.message}`);
      return { ok: true, action: 'none' };
    }
    if (!health) return { ok: true, action: 'none' };

    const masterUp = this.master?.status?.()?.uptimeSec || 0;
    const starved = health.videoIngestionStarved
      || (health.streamStatus === 'inactive' && masterUp > 45)
      || (health.healthStatus === 'bad' && ytSnap?.lifeCycleStatus === 'ready');

    if (!starved) return { ok: true, action: 'none' };

    const cooldownMs = parseInt(process.env.STREAM_DELIVERY_YT_INGEST_HEAL_COOLDOWN_SEC || '90', 10) * 1000;
    const now = Date.now();
    if (this._lastYtIngestHealAt && (now - this._lastYtIngestHealAt) < cooldownMs) {
      return { ok: true, action: 'none', reason: 'yt_ingest_heal_cooldown' };
    }
    this._lastYtIngestHealAt = now;
    this.log(`YouTube ingest heal — stream=${health.streamStatus} health=${health.healthStatus} lifecycle=${ytSnap?.lifeCycleStatus}`);
    const refreshed = this.refreshMasterEncoder('youtube_ingest_starved');
    return { ok: refreshed.refreshed, action: 'refresh_master_youtube_ingest', health, refreshed };
  }

  /**
   * Re-read LIVE_GRID_* encode vars from .env and restart ffmpeg on the same RTMP
   * broadcast (~5s blip). Keeps the YouTube listing — no new GO LIVE required.
   */
  reloadEncodeSettings() {
    if (!this.master?.running) return { ok: false, reason: 'encoder not running' };
    if (!process.env.RENDER) {
      try {
        require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), override: true });
      } catch (_) { /* non-fatal */ }
    }
    const cfg = gridEncodeConfig();
    const { outW, outH } = gridLayoutDims();
    this.log(`encode reload → ${outW}×${outH} ${cfg.fps}fps ${cfg.bitrateK}k video (same RTMP)`);
    this.master.restart();
    const out = { ok: true, encode: cfg, broadcastId: this.broadcast?.broadcastId || null };
    if (this.restreamer && this._rtmpDeliveryUrl) {
      this.restartRestreamerDelivery('encode_reload')
        .then((r) => this.log(`restreamer reload after encode: ${r.ok ? 'ok' : r.reason}`))
        .catch((e) => this.log(`restreamer reload failed: ${e.message}`));
      out.restreamerReload = 'scheduled';
    }
    return out;
  }

  /**
   * Downshift encode when host load is high — no manual .env edits required.
   * Called from broadcast-sidecar heartbeat while grid is live.
   */
  autoTuneEncodeIfNeeded() {
    if (!AUTOTUNE_LIVE) {
      return { ok: true, action: 'none', reason: 'LIVE_GRID_AUTOTUNE=off' };
    }
    if (!this.master?.running) return { ok: false, reason: 'encoder not running' };
    try {
      require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), override: true });
    } catch (_) { /* non-fatal */ }
    const os = require('os');
    const cores = Math.max(1, os.cpus().length);
    const loadPerCore = os.loadavg()[0] / cores;
    const threshold = parseFloat(process.env.LIVE_GRID_AUTOTUNE_LOAD || '1.35');
    const cfg = gridEncodeConfig();
    const { outW, outH } = gridLayoutDims();

    if (loadPerCore < threshold) {
      return { ok: true, action: 'none', loadPerCore: +loadPerCore.toFixed(2), encode: cfg };
    }

    let targetFps = cfg.fps;
    let targetBitrate = cfg.bitrateK;
    let targetW = outW;
    let targetH = outH;
    let changed = false;

    if (outW > 720 && loadPerCore > threshold) {
      targetW = 720;
      targetH = 720;
      changed = true;
    }
    if (cfg.fps > 30) { targetFps = 30; changed = true; }
    else if (cfg.fps > 24 && loadPerCore > threshold * 1.6) { targetFps = 24; changed = true; }

    if (cfg.bitrateK > 4500) { targetBitrate = 4500; changed = true; }
    else if (cfg.bitrateK > 3500 && loadPerCore > threshold * 1.5) { targetBitrate = 3500; changed = true; }

    if (!changed) {
      return { ok: true, action: 'none', loadPerCore: +loadPerCore.toFixed(2), encode: cfg };
    }

    process.env.LIVE_GRID_FPS = String(targetFps);
    process.env.LIVE_GRID_BITRATE_K = String(targetBitrate);
    process.env.LIVE_GRID_OUTPUT_W = String(targetW);
    process.env.LIVE_GRID_OUTPUT_H = String(targetH);
    const next = gridEncodeConfig();
    this.log(
      `encode autotune: load ${loadPerCore.toFixed(2)}/core → ${targetW}×${targetH} ${next.fps}fps ${next.bitrateK}k`
    );
    this.master.restart();
    return { ok: true, action: 'downshifted', loadPerCore: +loadPerCore.toFixed(2), encode: next };
  }

  /** Viewer-oriented delivery QA — signals for workers and self-heal. */
  buildDeliveryQa() {
    const { assessDelivery } = require('./delivery_qa');
    const snap = this._statusSnapshot();
    return assessDelivery(snap);
  }

  /** Clean restreamer restart without touching compositor / YouTube listing. */
  async restartRestreamerDelivery(reason = 'delivery_heal') {
    if (!this.restreamer || !this._rtmpDeliveryUrl) {
      return { ok: false, reason: 'no restreamer' };
    }
    const localPreview = require('./local_preview');
    const hlsPath = this._localPreview?.hlsPath || localPreview.resolveLocalPreviewConfig().hlsPath;
    this.log(`restreamer heal (${reason})`);
    this.restreamer.stop();
    this.restreamer = new GridRestreamer({
      hlsPath,
      rtmpUrl: this._rtmpDeliveryUrl,
      log: (m) => this.log(m),
    });
    await this.restreamer.start();
    return { ok: true, reason, component: 'restreamer' };
  }

  /** Restart compositor only — fixes stale HLS without new YouTube listing. */
  async restartCompositorDelivery(reason = 'delivery_heal') {
    if (!this.master?.running) {
      return { ok: false, reason: 'compositor not running', component: 'compositor' };
    }
    this.log(`compositor heal (${reason})`);
    this.master.opts.audioQuad = this.audioQuad;
    this.master.opts.muted = this.audioMuted;
    this.master.restart();
    const { waitForHls } = require('./grid_restreamer');
    const hlsPath = this._localPreview?.hlsPath
      || require('./local_preview').resolveLocalPreviewConfig().hlsPath;
    const ready = await waitForHls(hlsPath, parseInt(process.env.LIVE_GRID_DELIVERY_HLS_WAIT_MS || '45000', 10));
    return { ok: true, reason, component: 'compositor', hlsReady: ready };
  }

  /**
   * Full encode pipeline heal — compositor first when HLS stale, then restreamer.
   * Safe for YouTube listing (same RTMP key).
   */
  async healDeliveryPipeline(reason = 'delivery_heal') {
    if (!this.running) return { ok: false, reason: 'grid not running' };
    const { hlsPreviewLive } = require('./local_preview');
    const staleMs = parseInt(process.env.LIVE_GRID_DELIVERY_HLS_STALE_MS || '8000', 10);
    const actions = [];
    let hlsLive = hlsPreviewLive(staleMs);
    const useMw = outputMiddlewareEnabled();

    if (useMw && !hlsLive && this.master?.running) {
      const comp = await this.restartCompositorDelivery(reason);
      actions.push('restart_compositor');
      hlsLive = comp.hlsReady || hlsPreviewLive(staleMs);
    }

    const rsUp = this.restreamer?.status?.().running;
    if (this.restreamer && this._rtmpDeliveryUrl && (!rsUp || !hlsLive)) {
      if (hlsLive) {
        await this.restartRestreamerDelivery(reason);
        actions.push('restart_restreamer');
      } else {
        this.log(`delivery heal (${reason}): HLS still stale after compositor restart — skipping restreamer`);
      }
    }

    const qa = this.buildDeliveryQa();
    return {
      ok: qa.hls?.live && (this.restreamer?.status?.().running ?? true),
      action: actions.length ? actions.join('+') : 'none',
      actions,
      qa,
    };
  }

  /**
   * Automated response to delivery signals — compositor-first when HLS stale.
   * Called from broadcast-sidecar heartbeat while grid is live.
   */
  async autoHealDelivery() {
    const { deliveryAutoHealEnabled } = require('./delivery_qa');
    if (!deliveryAutoHealEnabled()) {
      return { ok: true, action: 'none', reason: 'STREAM_DELIVERY_AUTO_HEAL=off' };
    }
    if (!this.running) {
      return { ok: false, reason: 'grid not running' };
    }

    const ingestHeal = await this._maybeHealYoutubeIngest();
    if (ingestHeal.action && ingestHeal.action !== 'none') {
      return ingestHeal;
    }

    const qa = this.buildDeliveryQa();
    const actions = qa.selfHeal?.actions || [];
    if (!actions.length) {
      return { ok: true, action: 'none', qa };
    }

    const directRtmp = !outputMiddlewareEnabled() && !!this.broadcast?.broadcastId;
    if (directRtmp && PROTECT_YT_RTMP
      && actions.some((a) => a === 'restart_compositor' || a === 'restart_encode_pipeline')) {
      this.log('delivery auto-heal skipped — direct RTMP live (restart would drop YouTube viewers)');
      return { ok: true, action: 'none', reason: 'direct_rtmp_protected', qa };
    }

    if (actions.includes('downshift_encode')) {
      const tuned = this.autoTuneEncodeIfNeeded();
      if (tuned.action === 'downshifted') {
        return { ok: true, action: 'downshift_encode', ...tuned, qa };
      }
    }

    const needsCompositor = actions.includes('restart_compositor')
      || actions.includes('restart_encode_pipeline');
    const needsRestreamer = actions.includes('restart_restreamer')
      || actions.includes('restart_encode_pipeline');
    const hlsStale = qa.signals.some((s) => s.key === 'hls_stale' || s.key === 'master_hung');
    const rsDown = qa.signals.some((s) => s.key === 'restreamer_down');

    const compositorCooldown = parseInt(process.env.STREAM_DELIVERY_COMPOSITOR_HEAL_COOLDOWN_SEC || '120', 10) * 1000;
    const restreamerCooldown = parseInt(process.env.STREAM_DELIVERY_HEAL_COOLDOWN_SEC || '45', 10) * 1000;
    const now = Date.now();

    if (needsRestreamer && !needsCompositor && !hlsStale) {
      if (this._lastRestreamerHealAt && (now - this._lastRestreamerHealAt) < restreamerCooldown) {
        return { ok: true, action: 'none', reason: 'restreamer_cooldown', qa };
      }
      this._lastRestreamerHealAt = now;
      const restarted = await this.restartRestreamerDelivery('auto_heal');
      return { ...restarted, action: 'restart_restreamer', qa };
    }

    if (needsCompositor || hlsStale || (rsDown && !qa.hls?.live)) {
      if (this._lastCompositorHealAt && (now - this._lastCompositorHealAt) < compositorCooldown) {
        return { ok: true, action: 'none', reason: 'compositor_cooldown', qa };
      }
      this._lastCompositorHealAt = now;
      this._lastDeliveryHealAt = now;
      const healed = await this.healDeliveryPipeline('auto_heal');
      return { ...healed, qa };
    }

    if (needsRestreamer && qa.hls?.live) {
      if (this._lastRestreamerHealAt && (now - this._lastRestreamerHealAt) < restreamerCooldown) {
        return { ok: true, action: 'none', reason: 'restreamer_cooldown', qa };
      }
      this._lastRestreamerHealAt = now;
      const restarted = await this.restartRestreamerDelivery('auto_heal');
      return { ...restarted, action: 'restart_restreamer', qa };
    }

    return { ok: true, action: 'none', qa };
  }

  /** Regenerate + push YouTube title/description/tags from current grid layout. */
  async refreshYoutubeSeo(reason = 'operator', opts = {}) {
    const mainBid = opts.mainBroadcastId || this.broadcast?.broadcastId;
    if (!mainBid) return { refreshed: false, reason: 'no active broadcast' };
    this._syncAssignmentsFromFeeders();
    this.log(`YouTube SEO refresh (${reason})`);
    if (opts.headline) this.opts = { ...this.opts, headline: opts.headline };

    const feederStreamers = this._streamersFromFeeders();
    const layout = this._programLayout || {
      mode: opts.programMode || 'grid',
      modeLabel: 'Twitch multiview grid',
      title: gridTitle(this._feederLogins()),
      sources: this._feederLogins().map((l) => (l || null)),
    };
    const seoCtx = feederStreamers.length
      ? { ...this._buildSeoContext(layout), streamers: feederStreamers }
      : this._buildSeoContext(layout);
    if (!seoCtx.streamers.length) {
      return { refreshed: false, reason: 'no streamers on grid' };
    }

    const templatePack = buildGoLiveSeo({}, {
      operatorLocks: this.operatorLocks,
      programMode: layout.mode,
      streamers: seoCtx.streamers,
      assignments: this._feederLogins(),
      _resumeRuntime: this.opts,
    });
    let seo;
    if (templatePack.fromTemplate) {
      seo = templatePack.seo;
      this.log(`go-live template SEO refresh (${seoCtx.streamers.map((s) => s.login).join(', ')})`);
    } else {
      seo = await generateGridSeo(seoCtx);
    }
    if (!seo) return { refreshed: false, reason: 'no SEO generated' };

    const skipThumbnail = opts.skipThumbnail !== false;
    const seoResult = await this._applyYoutubeSeo(
      { ...seo, title: seo.title || layout.title },
      {
        programMode: layout.mode,
        layout,
        streamers: seoCtx.streamers,
        skipThumbnail,
        broadcastId: mainBid,
        setPublic: opts.setPublic,
      },
    );
    return {
      refreshed: true,
      reason,
      programMode: layout.mode,
      title: seo.title,
      streamers: seoCtx.streamers.map((s) => s.login),
      thumbnail: !!seoResult?.thumbnail,
      thumbnailMode: seoResult?.thumbnailMode || layout.mode,
    };
  }

  /** Push main grid + all solo seat YouTube SEO in one call. */
  async discoverYoutubeBroadcasts() {
    if (!yt.isConnected()) return { ok: false, reason: 'YouTube API not connected' };
    const { readSoloListingForQuadrant } = require('./solo_listings_env');
    const { discoverBroadcastIds } = require('./broadcast_discover');
    const broadcasts = await yt.listDiscoverableBroadcasts();
    const soloStreamIds = {};
    for (let q = 0; q < 4; q++) {
      const listing = readSoloListingForQuadrant(q);
      if (listing?.streamId) soloStreamIds[q + 1] = listing.streamId;
    }
    const mainStreamId = this.broadcast?.streamId || process.env.LIVE_GRID_STREAM_ID || null;
    const mainBroadcastIdFallback = this.broadcast?.broadcastId || process.env.LIVE_GRID_BROADCAST_ID || null;
    const ids = discoverBroadcastIds({
      broadcasts,
      mainStreamId,
      mainBroadcastIdFallback,
      soloStreamIds,
    });
    return { ok: true, broadcasts, ...ids };
  }

  _persistDiscoveredSoloIds(soloBroadcastIds = {}) {
    const { persistSoloListing, readSoloListingForQuadrant } = require('./solo_listings_env');
    const saved = [];
    for (let seat = 1; seat <= 4; seat++) {
      const bid = soloBroadcastIds[seat] || soloBroadcastIds[String(seat)];
      if (!bid) continue;
      const listing = readSoloListingForQuadrant(seat - 1);
      if (!listing?.rtmpUrl) continue;
      if (listing.broadcastId === bid) continue;
      persistSoloListing(seat - 1, {
        broadcastId: bid,
        watchUrl: `https://youtube.com/live/${bid}`,
        rtmpUrl: listing.rtmpUrl,
        streamId: listing.streamId,
        label: listing.label,
      });
      saved.push({ quadrant: seat, broadcastId: bid });
    }
    return saved;
  }

  async refreshAllYoutubeSeo(reason = 'operator', opts = {}) {
    this.log(`YouTube full SEO refresh (${reason})`);
    let mainBroadcastId = opts.mainBroadcastId;
    let soloBroadcastIds = opts.soloBroadcastIds;
    let discovered = null;

    const wantDiscover = opts.discover !== false
      && (!mainBroadcastId || !soloBroadcastIds || Object.keys(soloBroadcastIds).length === 0);
    if (wantDiscover && yt.isConnected()) {
      try {
        discovered = await this.discoverYoutubeBroadcasts();
        mainBroadcastId = mainBroadcastId || discovered.mainBroadcastId;
        soloBroadcastIds = soloBroadcastIds || discovered.soloBroadcastIds;
        this.log(`discovered broadcasts main=${mainBroadcastId || '(none)'} solos=${JSON.stringify(soloBroadcastIds || {})}`);
        if (opts.persistDiscovered !== false && soloBroadcastIds) {
          const saved = this._persistDiscoveredSoloIds(soloBroadcastIds);
          if (saved.length) this.log(`persisted discovered solo IDs: ${saved.map((s) => `Q${s.quadrant}=${s.broadcastId}`).join(', ')}`);
        }
      } catch (e) {
        this.log(`broadcast discover failed: ${e.message}`);
      }
    }

    const main = await this.refreshYoutubeSeo(reason, {
      ...opts,
      mainBroadcastId,
      skipThumbnail: opts.thumbnail !== true,
    });
    const solo = await this.refreshSoloYoutubeSeo({
      soloBroadcastIds,
      setPublic: opts.setPublic,
    });
    return { ok: true, discovered, main, solo };
  }

  _nudgeRelayAfterSwap(q, login) {
    this._nudgeSoloAfterSwap(q, login);
    if (USE_UDP_RELAY) {
      // Relay self-heals on RTSP EOF when the feeder swaps — explicit nudge races
      // the natural reconnect and starves the master UDP input.
      return;
    }
    this.relays?.restart(q);
    this._scheduleFreezeCheck(q, login);
  }

  _nudgeSoloAfterSwap(q, login) {
    if (!this.soloPublishers?.started) return;
    this.soloPublishers.restart(q, login);
    this._soloAnnouncer?.schedule();
  }

  _scheduleUdpMasterRefresh(q, login) {
    if (UDP_MASTER_REFRESH_MS <= 0) return;
    this._udpRefreshPending.add(q);
    clearTimeout(this._udpRefreshTimer);
    this._udpRefreshTimer = setTimeout(async () => {
      const pending = [...this._udpRefreshPending];
      this._udpRefreshPending.clear();
      if (!this.running) return;
      for (const qq of pending) {
        const expected = this._lastAssignments[qq];
        if (!expected) continue;
        if (!(await rtspHasVideo(quadUrl(qq), 4000))) {
          this.log(`quad${qq + 1} RTSP not stable — skip master refresh`);
          return;
        }
      }
      const names = pending.map(qq => this._lastAssignments[qq]).filter(Boolean).join(', ');
      this.refreshMasterEncoder(`UDP relay recovery (${names || pending.map(q => `Q${q + 1}`).join(', ')})`);
    }, UDP_MASTER_REFRESH_MS);
    this._udpRefreshTimer.unref?.();
  }

  _applySourceLayout(layout, prevSources) {
    const sources = layout.sources;
    const prevCount = (this._lastAssignments || []).filter(Boolean).length;
    this.feeders.applySources(sources);
    this._lastAssignments = this._sourcesToLogins(sources);
    this._programLayout = layout;

    for (let q = 0; q < 4; q++) {
      if (!this._sourcesChanged([sources[q]], [prevSources[q]])) continue;
      this._nudgeRelayAfterSwap(q, this._lastAssignments[q]);
    }

    if (this.broadcast) {
      const prevCount = (this._lastAssignments || []).filter(Boolean).length;
      const nextCount = this._lastAssignments.filter(Boolean).length;
      if (prevCount === 0 && nextCount > 0) {
        this._applyYoutubeSeoFromLayout(layout)
          .catch(e => this.log(`YouTube SEO fill-in failed: ${e.message}`));
      } else {
        this._scheduleSeoUpdate(layout, { swap: true });
      }
      this._scheduleSoloSeoUpdate();
      this._scheduleMainTitleUpdate();
    }
  }

  /** Debounced main grid title push when assignments change (matches solo refresh cadence). */
  _scheduleMainTitleUpdate() {
    if (!this.broadcast?.broadcastId) return;
    clearTimeout(this._mainSeoSwapTimer);
    this._mainSeoSwapTimer = setTimeout(() => {
      if (!this.running) return;
      this.refreshYoutubeSeo('grid_swap', { skipThumbnail: true })
        .catch((e) => this.log(`main title refresh failed: ${e.message}`));
    }, SOLO_SEO_SWAP_DEBOUNCE_MS);
    this._mainSeoSwapTimer.unref?.();
  }

  /** Debounced solo title/SEO push when grid assignments change. */
  _scheduleSoloSeoUpdate() {
    try {
      const { soloStreamsEnabled, soloStreamsConfigured } = require('./solo_listings_env');
      if (!soloStreamsEnabled() || !soloStreamsConfigured()) return;
    } catch (_) {
      return;
    }
    clearTimeout(this._soloSeoSwapTimer);
    this._soloSeoSwapTimer = setTimeout(() => {
      if (!this.running) return;
      this.refreshSoloYoutubeSeo()
        .catch((e) => this.log(`solo SEO refresh failed: ${e.message}`));
    }, SOLO_SEO_SWAP_DEBOUNCE_MS);
    this._soloSeoSwapTimer.unref?.();
  }

  /** Skip heavy SEO/thumbnail work during live operator swaps — debounce title-only updates. */
  _scheduleSeoUpdate(layout, { swap = false } = {}) {
    if (!this.broadcast) return;
    if (swap && !SEO_ON_SWAP) {
      clearTimeout(this._seoSwapTimer);
      this._seoSwapTimer = setTimeout(() => {
        if (!this.running) return;
        this._applyYoutubeSeoFromLayout(layout, { skipThumbnail: true })
          .catch(e => this.log(`debounced YouTube title update failed: ${e.message}`));
      }, SEO_SWAP_DEBOUNCE_MS);
      this._seoSwapTimer.unref?.();
      return;
    }
    this._applyYoutubeSeoFromLayout(layout)
      .catch(e => this.log(`YouTube SEO update failed: ${e.message}`));
  }

  _buildSeoContext(layout = this._programLayout) {
    const feederStreamers = this._streamersFromFeeders();
    const live = this.poller?.lastLive || {};
    const eventFeed = layout?.eventFeed || this._eventFeed;
    const headline = layout?.mode === 'news_desk'
      ? (this.opts?.headline || 'ClipzWorld News Desk — Breaking & Analysis')
      : (eventFeed?.title
        || layout?.title?.replace(/^🔴 LIVE:\s*/i, '').split('|')[0]?.trim()
        || layout?.modeLabel
        || 'ClipzWorld Watch Party');

    if (feederStreamers.length) {
      return {
        streamers: feederStreamers,
        programMode: layout?.mode,
        headline,
        subline: layout?.modeLabel || 'Multi-Stream Watch Party',
      };
    }

    const streamers = [];
    const sources = layout?.sources || [];

    for (let q = 0; q < 4; q++) {
      const src = sources[q];
      const lock = this.operatorLocks[q];
      const login = this._lastAssignments?.[q] || (lock?.type === 'channel' ? lock.login : null);
      if (src && typeof src === 'object' && src.type === 'url') {
        const slug = lock?.login || channelFromFeedUrl(src.url) || src.label?.toLowerCase?.() || eventFeed?.channel || 'feed';
        streamers.push({
          login: slug,
          displayName: displayName(slug),
          viewers: live[slug] || eventFeed?.viewers || 0,
          role: 'co-stream',
        });
      } else if (src && typeof src === 'object' && src.type === 'file') {
        const label = src.label || path.basename(src.path || '', path.extname(src.path || ''));
        streamers.push({
          login: label.toLowerCase().replace(/\s+/g, '_'),
          displayName: label,
          viewers: 0,
          role: q === 0 ? 'main' : 'segment',
        });
      } else if (login) {
        streamers.push({
          login,
          displayName: displayName(login),
          viewers: live[login] || 0,
          role: 'co-stream',
        });
      }
    }

    const headlineFromLayout = layout?.mode === 'news_desk'
      ? (this.opts?.headline || 'ClipzWorld News Desk — Breaking & Analysis')
      : (eventFeed?.title
        || layout?.title?.replace(/^🔴 LIVE:\s*/i, '').split('|')[0]?.trim()
        || layout?.modeLabel
        || 'ClipzWorld Watch Party');

    return {
      streamers,
      programMode: layout?.mode,
      headline: headlineFromLayout,
      subline: layout?.modeLabel || 'Multi-Stream Watch Party',
    };
  }

  async _applyYoutubeSeo(seo, thumbOpts = {}) {
    const broadcastId = thumbOpts.broadcastId || this.broadcast?.broadcastId;
    if (!broadcastId || !seo?.title) return { thumbnail: false };
    let thumbnailPath = null;
    const seoCtx = this._buildSeoContext(thumbOpts.layout);
    const programMode = thumbOpts.programMode || seoCtx.programMode || this._programLayout?.mode || 'grid';
    const streamers = thumbOpts.streamers || seoCtx.streamers;
    const skipThumbnail = thumbOpts.skipThumbnail === true;
    if (!skipThumbnail && String(process.env.LIVE_GRID_LIVE_THUMBNAIL || 'on').toLowerCase() !== 'off') {
      const thumb = await generateLiveThumbnail({
        headline: seo.thumbnailHeadline || seoCtx.headline || seo.title.replace(/^🔴 LIVE:\s*/i, '').slice(0, 60),
        subline: seo.thumbnailSubline || seoCtx.subline,
        programMode,
        streamers,
      });
      if (thumb.ok) {
        thumbnailPath = thumb.path;
        this.log(`live thumbnail (${programMode}): ${path.basename(thumb.path)}`);
      } else if (thumb.error) {
        this.log(`live thumbnail skipped: ${thumb.error}`);
      }
    }
    const result = await yt.applyLiveBroadcastSeo(broadcastId, seo, {
      thumbnailPath,
      log: (m) => this.log(m),
      setPublic: thumbOpts.setPublic,
    });
    if (thumbnailPath && this.verticalBroadcast?.broadcastId) {
      try {
        await yt.setVideoThumbnail(this.verticalBroadcast.broadcastId, thumbnailPath);
        this.log('YouTube vertical thumbnail set');
        result.verticalThumbnail = true;
      } catch (e) {
        this.log(`YouTube vertical thumbnail failed: ${e.response?.data?.error?.message || e.message}`);
        result.verticalThumbnail = false;
      }
    }
    if (result.thumbnail) this.log('YouTube custom thumbnail set');
    else if (thumbnailPath) this.log('YouTube thumbnail upload returned false — channel may need verification for custom thumbs');
    if (result.tags) this.log(`YouTube tags set (${seo.tags?.length || 0})`);
    return { ...result, thumbnailMode: programMode, thumbnailPath };
  }

  /**
   * Atomically remove a grid streamer and seat a replacement (or slate).
   * Avoids roster remove + pollOnce auto-fill racing ahead of a manual assign.
   */
  replaceQuadrant(q, { remove, replace } = {}) {
    if (!this.running) throw new Error('live grid not running');
    if (!Number.isInteger(q) || q < 0 || q > 3) throw new Error('quadrant must be 0-3');
    if (!this.poller) throw new Error('poller not ready');

    const removed = remove ? String(remove).trim().toLowerCase() : null;
    const next = replace === undefined
      ? null
      : (String(replace || '').trim().toLowerCase() || null);

    if (removed) this.poller.updateRoster({ remove: [removed] });
    if (next) this.poller.updateRoster({ benchAdd: [next] });

    const { prev } = this.poller.setOperatorSeat(q, next);
    if (removed && prev && prev !== removed) {
      this.log(`replace Q${q + 1}: grid had ${prev}, remove asked for ${removed}`);
    }

    if (next) {
      this.operatorLocks[q] = { type: 'channel', login: next };
      this.poller.unlockSlate(q);
      this.feeders.setQuadrant(q, next);
    } else {
      this.operatorLocks[q] = { type: 'slate' };
      this.poller.lockSlate(q);
      this.poller.setOperatorSeat(q, null);
      this.feeders.setQuadrant(q, null);
    }

    if (this._programLayout?.sources) {
      this._programLayout.sources[q] = next;
      this._lastAssignments = this._sourcesToLogins(this._programLayout.sources);
    } else {
      this._lastAssignments[q] = next;
    }

    if (this.broadcast && this._programLayout) {
      this._scheduleSeoUpdate(this._programLayout, { swap: true });
    }

    this.log(`Q${q + 1} replace: ${removed || prev || '(empty)'} → ${next || 'slate'} (single swap)`);
    return this.feeders.status()[q];
  }

  async _applyYoutubeSeoAfterLaunch() {
    let layout = this._programLayout;
    let ctx = this._buildSeoContext(layout);
    if (!ctx.streamers.length && this.poller) {
      this.log('YouTube SEO waiting for grid streamers…');
      const { assignments } = await this.poller.pollOnce();
      this._lastPollerAssignments = [...assignments];
      layout = await this._applyProgram(assignments);
      this._programLayout = layout;
      this._lastAssignments = this._sourcesToLogins(layout.sources);
      this.feeders?.applySources(layout.sources);
      ctx = this._buildSeoContext(layout);
    }
    if (!ctx.streamers.length) {
      this.log('YouTube SEO skipped for now — no streamers seated (updates on first bench fill)');
      return { skipped: true, reason: 'no_streamers' };
    }
    this.log(`YouTube SEO applying for ${ctx.streamers.map((s) => s.login).join(', ')}`);
    return this._applyYoutubeSeoFromLayout(layout);
  }

  async _applyYoutubeSeoFromLayout(layout, opts = {}) {
    const seoCtx = this._buildSeoContext(layout);
    const templatePack = buildGoLiveSeo({}, {
      operatorLocks: this.operatorLocks,
      assignments: this._feederLogins(),
      streamers: seoCtx.streamers,
      programMode: layout?.mode,
      _resumeRuntime: this.opts,
    });
    let seo;
    let streamers;
    if (templatePack.fromTemplate && !opts.forcePollerSeo) {
      seo = templatePack.seo;
      streamers = templatePack.streamers;
    } else {
      seo = await generateGridSeo(seoCtx);
      streamers = seoCtx.streamers;
    }
    if (!seo) return;
    // Prefer regenerated SEO title — layout.title is a short template; stale GPT titles must not stick.
    const title = seo.title || layout?.title;
    await this._applyYoutubeSeo(
      { ...seo, title },
      {
        programMode: layout?.mode,
        layout,
        streamers: seoCtx.streamers,
        skipThumbnail: opts.skipThumbnail === true,
      }
    );
  }

  /** Drop or apply avatar PIP when daypart changes — restarts master ffmpeg (~5s blip, same RTMP). */
  _syncAvatarPip(layout = this._programLayout) {
    if (!this.master?.running) return { changed: false };
    const want = this.opts.avatarOverlay === false
      ? null
      : resolveAvatarOverlay(this._pipOverlayOpts(layout));
    const prev = this._avatarOverlayPath || this.master.opts.avatarOverlay || null;
    if (prev === want) return { changed: false, avatarOverlay: want };
    this._avatarOverlayPath = want;
    this.master.opts.avatarOverlay = want;
    if (want) this.log(`avatar PIP → ${path.basename(want)} (compositor restart)`);
    else this.log('avatar PIP off — compositor restart (grid quadrants clear)');
    if (PROTECT_YT_RTMP && this.broadcast?.broadcastId) {
      this.log('avatar PIP change skipped encoder restart — protects YouTube RTMP (LIVE_GRID_PROTECT_YT_RTMP=on)');
      return { changed: true, avatarOverlay: want, encoderRestart: false };
    }
    this.master.restart();
    return { changed: true, avatarOverlay: want };
  }

  setQuadrantFile(q, filePath, label) {
    if (!Number.isInteger(q) || q < 0 || q > 3) throw new Error('quadrant must be 0-3');
    const abs = path.resolve(filePath);
    if (!isAllowedFilePath(abs)) throw new Error(`file not allowed: ${filePath}`);
    this.operatorLocks[q] = { type: 'file', path: abs, label: label || path.basename(abs) };
    this.feeders.setQuadrantFile(q, abs, label);
    this._nudgeRelayAfterSwap(q, null);
    if (this._programLayout?.sources) {
      this._programLayout.sources[q] = { type: 'file', path: abs, label: label || path.basename(abs) };
      this._lastAssignments = this._sourcesToLogins(this._programLayout.sources);
    }
    return this.feeders.status()[q];
  }

  setQuadrantUrl(q, feedUrl, label, opts = {}) {
    if (!Number.isInteger(q) || q < 0 || q > 3) throw new Error('quadrant must be 0-3');
    const slug = opts.login || channelFromFeedUrl(feedUrl);
    this.feeders.setQuadrantUrl(q, feedUrl, label, { login: slug, ...opts });
    this.operatorLocks[q] = { type: 'url', url: feedUrl, label: label || null, title: opts.title, login: slug };
    this._nudgeRelayAfterSwap(q, null);
    if (this._programLayout?.sources) {
      this._programLayout.sources[q] = { type: 'url', url: feedUrl, label: label || slug || '', title: opts.title || '' };
      this._lastAssignments = this._sourcesToLogins(this._programLayout.sources);
    }
    return this.feeders.status()[q];
  }

  /** Operator lock — Twitch channel on quadrant q (survives poller ticks). */
  setQuadrantChannel(q, login) {
    if (!Number.isInteger(q) || q < 0 || q > 3) throw new Error('quadrant must be 0-3');
    const slug = String(login || '').trim().toLowerCase();
    if (!slug) throw new Error('login required');
    this.poller?.unlockSlate(q);
    this.operatorLocks[q] = { type: 'channel', login: slug };
    this.poller?.pinQuadrant(q, slug);
    writeNameFile(q, slug);
    const { refreshQuadrantAvatarSync } = require('./avatar_cache');
    refreshQuadrantAvatarSync(q, slug);
    this.feeders.setQuadrant(q, slug);
    this._nudgeRelayAfterSwap(q, slug);
    this._scheduleAvatarEncoderRefresh();
    if (this._programLayout?.sources) {
      this._programLayout.sources[q] = slug;
      this._lastAssignments = this._sourcesToLogins(this._programLayout.sources);
    }
    this.log(`operator lock Q${q + 1} → ${slug}`);
    this._syncAvatarPip();
    return this.feeders.status()[q];
  }

  clearQuadrantLock(q) {
    if (!Number.isInteger(q) || q < 0 || q > 3) throw new Error('quadrant must be 0-3');
    this.operatorLocks[q] = null;
    this.poller?.unlockSlate(q);
    this.poller?.clearPin(q);
    this.log(`operator lock cleared Q${q + 1}`);
    return { ok: true };
  }

  async _refreshGridAvatars() {
    const { refreshQuadrantAvatar } = require('./avatar_cache');
    const tasks = [];
    for (let q = 0; q < 4; q++) {
      const lock = this.operatorLocks[q];
      const login = lock?.login || this.feeders?.quads?.[q]?.login || null;
      if (login) tasks.push(refreshQuadrantAvatar(q, login));
    }
    await Promise.allSettled(tasks);
  }

  _scheduleAvatarEncoderRefresh() {
    clearTimeout(this._avatarRefreshTimer);
    this._avatarRefreshTimer = setTimeout(async () => {
      if (!this.running || !this.master) return;
      await this._refreshGridAvatars();
      if (PROTECT_YT_RTMP && this.broadcast?.broadcastId) {
        this.log('avatar PNGs refreshed — encoder restart skipped (protects YouTube RTMP)');
        return;
      }
      this.master.restart();
      this.log('encoder refreshed — on-air avatars reloaded');
    }, 5000);
    this._avatarRefreshTimer.unref?.();
  }

  syncQuadrantLabels() {
    for (let q = 0; q < 4; q++) {
      const lock = this.operatorLocks[q];
      if (lock?.type === 'channel' && lock.login) writeNameFile(q, lock.login);
    }
    this.feeders?.syncNameFiles();
    const { nameFile: nf } = require('./feeders');
    const fs = require('fs');
    return this.feeders?.status()?.map(q => ({
      quadrant: q.quadrant,
      login: q.login,
      label: fs.readFileSync(nf(q.quadrant - 1), 'utf8').trim(),
    })) || [];
  }

  _lockCurrentGridAsOperator() {
    const logins = this._lastAssignments || this._sourcesToLogins(this._programLayout?.sources || []);
    for (let q = 0; q < 4; q++) {
      const login = logins[q];
      if (!login) continue;
      this.operatorLocks[q] = { type: 'channel', login };
      this.poller?.pinQuadrant(q, login);
      if (this.poller) this.poller.assignments[q] = login;
      if (this.feeders) {
        writeNameFile(q, login);
        this.feeders.setQuadrant(q, login);
      }
    }
    this.feeders?.syncNameFiles();
  }

  setOperatorMode(enabled) {
    if (!this.poller) throw new Error('grid not started');
    this.poller.operatorMode = !!enabled;
    if (this.poller.operatorMode) {
      this._lockCurrentGridAsOperator();
    } else {
      this._stickTemplateLocks = false;
      for (let q = 0; q < 4; q++) {
        this.poller?.clearPin(q);
        const lock = this.operatorLocks[q];
        if (lock?.type === 'channel') {
          this.operatorLocks[q] = null;
        }
      }
      this.poller?.pollOnce().catch((e) => this.log(`auto pilot poll failed: ${e.message}`));
    }
    this.log(this.poller.operatorMode
      ? 'operator mode ON — lineup locked; offline seats auto-fill from follows then bench (no viewer reshuffles)'
      : 'auto pilot ON — bench fills empty quadrants and viewer swaps resume');
    return { operatorMode: this.poller.operatorMode };
  }

  _lineup(assignments) {
    const live = this.poller?.lastLive || {};
    return assignments.filter(Boolean).map(login => ({ login, viewers: live[login] || 0 }));
  }

  _quadrantUnhealthy(q) {
    const quad = this.feeders?.quads[q];
    if (!quad) return true;
    if (quad.feedUnhealthy) return true;
    const restarts = this.relays?.restarts?.[q] || 0;
    const threshold = parseInt(process.env.LIVE_GRID_UNHEALTHY_RELAY_RESTARTS || '20', 10);
    if (restarts >= threshold) return true;
    return false;
  }

  _quadrantHealthFlags() {
    return [0, 1, 2, 3].map((q) => this._quadrantUnhealthy(q));
  }

  _onFeedUnhealthy(q, info) {
    if (!this.running) return;
    this._benchUnhealthyQuadrant(q, info);
  }

  _benchUnhealthyQuadrant(q, info) {
    const label = info.label || info.login || info.feedUrl || 'feed';
    this.log(`feed guard: benching quad${q + 1} (${label}) after repeated failures`);

    if (this.audioQuad === q) {
      const next = this._autoAudioQuad(this._lastAssignments);
      if (next >= 0 && next !== q) {
        if (this.audioMode === 'manual') {
          this.log('feed guard: moving audio off unhealthy pinned quadrant');
        }
        this._applyAudio(next, 'auto');
      }
    }

    if (info.kind === 'url' && info.feedUrl) {
      this._benchedFeeds.add(info.feedUrl);
    } else if (info.login) {
      this.poller?.updateRoster({ remove: [info.login] });
    }

    this.clearQuadrantLock(q);
    this.feeders.setQuadrant(q, null);
    if (this._programLayout?.sources) {
      this._programLayout.sources[q] = null;
      this._lastAssignments = this._sourcesToLogins(this._programLayout.sources);
    }

    const quad = this.feeders?.quads[q];
    if (quad) {
      quad.feedUnhealthy = false;
      quad.feedFailures = 0;
      quad.feedFailureWindowStart = 0;
    }
  }

  _autoAudioQuad(assignments) {
    const live = this.poller?.lastLive || {};
    const unhealthy = this._quadrantHealthFlags();
    const clean = pickAudioQuad(assignments, live, this._musicFlags, { unhealthyQuads: unhealthy });
    if (clean.quad >= 0) return clean.quad;
    let best = -1, bestViewers = -1;
    assignments.forEach((login, q) => {
      if (!login || unhealthy[q]) return;
      if ((live[login] || 0) > bestViewers) { best = q; bestViewers = live[login] || 0; }
    });
    if (best >= 0) return best;
    for (let q = 0; q < 4; q++) {
      if (!unhealthy[q] && assignments[q]) return q;
    }
    return 0;
  }

  setAudio(quadrant, source = 'manual') {
    if (quadrant === 'auto') {
      this.audioMode = 'auto';
      this.audioPinSource = null;
      this._musicHopManualPin = null;
      this.log('audio control released to auto (follow the leader)');
      this._applyAudio(this._autoAudioQuad(this._lastAssignments), 'auto');
      return true;
    }
    const q = Number(quadrant);
    if (!Number.isInteger(q) || q < 0 || q > 3) return false;
    const quadKind = this.feeders?.quads[q]?.kind;
    if (!this._lastAssignments[q] && quadKind !== 'file' && quadKind !== 'url') {
      this.log(`audio → quad${q + 1} ignored (slate)`);
      return false;
    }
    if (this._quadrantUnhealthy(q)) {
      this.log(`audio → quad${q + 1} ignored (unhealthy feed)`);
      return false;
    }
    if (source === 'manual' || source === 'chat') {
      this.audioMode = 'manual';
      this.audioPinSource = source;
      this._musicHopManualPin = null;
      if (this.audioMuted || this.fallbackMusicActive) this._clearAudioProtect();
    } else if (source === 'listen') {
      if (this.audioMuted || this.fallbackMusicActive) this._clearAudioProtect();
    } else if (this.audioMode !== 'manual') {
      this.audioMode = source;
    }
    if (this.audioMuted) this._setMuted(false);
    return this._applyAudio(q, source);
  }

  _audioSourceName(q) {
    const login = this._lastAssignments[q];
    if (login) return login;
    const quad = this.feeders?.quads[q];
    if (quad?.kind === 'url') return quad.label || quad.feedUrl || 'feed';
    if (quad?.kind === 'file') return quad.label || 'file';
    return 'slate';
  }

  _applyAudio(q, source) {
    if (q === this.audioQuad) return false;
    this.audioQuad = q;
    if (this.master) {
      const switched = this.master.setAudioQuad(q);
      if (!switched) {
        this.log(`on-air audio pin → quad${q + 1} (AAC copy mode — hot-switch unavailable; RTMP restart skipped)`);
      }
    }
    this.log(`on-air audio → quad${q + 1} (${this._audioSourceName(q)}, ${source})`);
    return true;
  }

  _scheduleFreezeCheck(q, login) {
    if (USE_UDP_RELAY) return;
    clearTimeout(this._freezeTimers[q]);
    if (!login) return;
    this._freezeTimers[q] = setTimeout(async () => {
      if (!this.running || this._lastAssignments[q] !== login) return;
      const ok = await rtspHasVideo(quadUrl(q));
      if (!ok) {
        this.log(`quad${q + 1} (${login}) RTSP dead after swap — master restart fallback`);
        this.master?.restart();
      }
    }, FREEZE_FALLBACK_MS);
    this._freezeTimers[q].unref?.();
  }

  _onAssignments(assignments) {
    if (!this.running) return;
    const prevSources = this._programLayout?.sources || [];
    this._lastPollerAssignments = [...assignments];
    this._applyProgram(assignments)
      .then((layout) => {
        if (!this.running) return;
        const sources = layout.sources;
        const changed = this._sourcesChanged(sources, prevSources);
        const prevLogins = this._sourcesToLogins(prevSources);
        if (changed || !this.poller?.operatorMode) {
          this.feeders.applySources(sources);
        }
        this._lastAssignments = this._sourcesToLogins(sources);
        this._programLayout = layout;

        if (this.swapController && changed) {
          for (let q = 0; q < 4; q++) {
            const next = this._lastAssignments[q];
            if (prevLogins[q] !== next) this.swapController.onAssignmentChange(q, next);
          }
        }

        if (changed && this.poller?.operatorMode) {
          for (let q = 0; q < 4; q++) {
            const login = this._lastAssignments[q];
            const lock = this.operatorLocks[q];
            if (lock?.type === 'slate') continue;
            if (this._stickTemplateLocks && lock?.type === 'channel') continue;
            if (lock?.type === 'channel') {
              if (login && login !== lock.login) {
                this.operatorLocks[q] = { type: 'channel', login };
                this.poller?.pinQuadrant(q, login);
                this.log(`operator Q${q + 1} auto-filled offline seat → ${login}`);
              } else if (!login) {
                this.operatorLocks[q] = null;
                this.poller?.clearPin(q);
              }
            } else if (login) {
              this.operatorLocks[q] = { type: 'channel', login };
              this.poller?.pinQuadrant(q, login);
              this.log(`operator Q${q + 1} auto-filled empty seat → ${login}`);
            }
          }
        }

        const live = this.poller?.lastLive || {};
        const audibleLogin = this._lastAssignments[this.audioQuad];
        const audibleKind = this.feeders?.quads[this.audioQuad]?.kind;
        const audibleNonTwitch = audibleKind === 'file' || audibleKind === 'url';
        if (!audibleLogin && !audibleNonTwitch) {
          const next = this._autoAudioQuad(this._lastAssignments);
          const nextKind = this.feeders?.quads[next]?.kind;
          if (this._lastAssignments[next] || nextKind === 'file' || nextKind === 'url') {
            if (this.audioMode === 'manual') this.log('manual audio pin released — pinned quadrant went slate');
            this.audioMode = 'auto';
            this._applyAudio(next, 'auto');
          }
        } else if (this.audioMode === 'auto' && !this.poller?.operatorMode) {
          const leader = this._autoAudioQuad(this._lastAssignments);
          const leaderLogin = this._lastAssignments[leader];
          if (leaderLogin && leader !== this.audioQuad &&
              (live[leaderLogin] || 0) >= (live[audibleLogin] || 0) * AUDIO_LEAD_RATIO) {
            this._applyAudio(leader, 'auto');
          }
        }

        if (changed) {
          for (let q = 0; q < 4; q++) {
            if (!this._sourcesChanged([sources[q]], [prevSources[q]])) continue;
            this._nudgeRelayAfterSwap(q, this._lastAssignments[q]);
          }

          if (SWAP_RESTART && !USE_UDP_RELAY) {
            clearTimeout(this._restartTimer);
            this._restartTimer = setTimeout(() => {
              if (!this.running || !this.master) return;
              this.master.restart();
            }, SWAP_RESTART_DEBOUNCE_MS);
          }

          if (this.broadcast) {
            this._scheduleSeoUpdate(layout, { swap: true });
          }
        }
      })
      .catch(e => this.log(`assignment apply failed: ${e.message}`));
  }

  async stop(opts = {}) {
    if (!this.running) return;
    this.running = false;
    const endBroadcast = opts.endBroadcast === true;
    const skipEndBroadcast = opts.skipEndBroadcast === true || !endBroadcast;
    for (const t of this._freezeTimers) clearTimeout(t);
    clearTimeout(this._restartTimer);
    clearTimeout(this._seoSwapTimer);
    clearTimeout(this._goPublicTimer);
    clearTimeout(this._soloAutoStartTimer);
    this._goPublicTimer = null;
    this._soloAutoStartTimer = null;
    if (this._programTick) clearInterval(this._programTick);
    this._programTick = null;
    this.poller?.stop();
    this.chat?.stop();
    this.likeTracker?.stop();
    this.musicDetector?.stop();
    this.youtubeSync?.stop();
    this.youtubeSync = null;
    this.restreamer?.stop();
    this.restreamer = null;
    this.swapController?.stop();
    this.swapController = null;
    this.master?.stop();
    this.soloPublishers?.stopAll();
    this.soloPublishers = null;
    this._soloAnnouncer?.reset();
    this._soloAnnouncer = null;
    this.relays?.stopAll();
    this.feeders?.stopAll();
    if (this.caffeinate) { try { this.caffeinate.kill(); } catch (_) {} }
    if (endBroadcast && this.broadcast) {
      try { await yt.endLiveBroadcast(this.broadcast.broadcastId); this.log('landscape broadcast ended'); }
      catch (e) { this.log(`endLiveBroadcast failed: ${e.response?.data?.error?.message || e.message}`); }
      try {
        const { persistYoutubeListing } = require('./youtube_listing_env');
        persistYoutubeListing({ broadcastId: '' });
        this.log('cleared YouTube listing from .env (create new Studio listing before next go-live)');
      } catch (e) { this.log(`listing env clear failed: ${e.message}`); }
      try {
        const { clearWasLive } = require('./was_live_env');
        const { clearResume } = require('./resume_state');
        clearWasLive();
        clearResume();
      } catch (_) {}
    } else if (skipEndBroadcast && this.broadcast) {
      this.log('encoder stopped — YouTube listing kept open (reconnect RTMP to resume)');
    }
    if (endBroadcast && this.verticalBroadcast) {
      try { await yt.endLiveBroadcast(this.verticalBroadcast.broadcastId); this.log('vertical broadcast ended'); }
      catch (e) { this.log(`vertical endLiveBroadcast failed: ${e.response?.data?.error?.message || e.message}`); }
    }
    this.log('live grid stopped');
  }

  status() {
    const snap = this._statusSnapshot();
    const { assessDelivery } = require('./delivery_qa');
    snap.delivery = assessDelivery(snap);
    return snap;
  }

  _statusSnapshot() {
    const ytSnap = this._youtubeStatus || this.youtubeSync?.statusSnapshot?.() || null;
    const staleLocal = !!(this.running && ytSnap && ytSnap.liveOnYouTube === false);
    return {
      running: this.running,
      uptimeSec: this.startedAt && this.running ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      broadcast: this.broadcast ? {
        id: this.broadcast.broadcastId,
        watchUrl: this.broadcast.watchUrl,
        streamId: this.broadcast.streamId || null,
        localOnly: !!this.broadcast.localOnly,
        hlsUrl: this.broadcast.hlsUrl || this._localPreview?.hlsUrl || null,
      } : null,
      youtube: ytSnap ? {
        lifeCycleStatus: ytSnap.lifeCycleStatus,
        privacyStatus: ytSnap.privacyStatus || this._listingPrivacy || this._requestedPrivacy || null,
        liveOnYouTube: ytSnap.liveOnYouTube,
        staleLocal,
        checkedAt: ytSnap.checkedAt || null,
        title: ytSnap.title || null,
        deliveryWidth: this._youtubeDeliveryAspect?.width || null,
        deliveryHeight: this._youtubeDeliveryAspect?.height || null,
      } : (this._youtubeDeliveryAspect ? {
        deliveryWidth: this._youtubeDeliveryAspect.width,
        deliveryHeight: this._youtubeDeliveryAspect.height,
      } : null),
      verticalBroadcast: this.verticalBroadcast
        ? { id: this.verticalBroadcast.broadcastId, watchUrl: this.verticalBroadcast.watchUrl } : null,
      encode: this._rtmpEncodePlan || null,
      quadrants: this.feeders ? this.feeders.status() : [],
      operatorLocks: this.operatorLocks.map((lock, i) => lock ? { quadrant: i + 1, ...lock } : null).filter(Boolean),
      audio: {
        quadrant: this.audioQuad + 1,
        login: this._lastAssignments[this.audioQuad] || null,
        label: this.feeders?.status()?.[this.audioQuad]?.displayName
          || this.feeders?.status()?.[this.audioQuad]?.label
          || null,
        mode: this.audioMode,
        pinSource: this.audioPinSource,
        chatControl: !!this.chat?.running,
        muted: this.audioMuted,
        fallbackMusic: this.fallbackMusicActive,
        fallbackTrack: this.fallbackMusicActive && this._fallbackMusicPath
          ? path.basename(this._fallbackMusicPath) : null,
        protectReason: this.audioProtectReason,
        musicFlags: [...this._musicFlags],
        musicWarning: this.audioMode === 'manual' && !!this._musicFlags[this.audioQuad],
      },
      poller: this.poller ? this.poller.status() : null,
      program: this.programDirector ? {
        ...this.programDirector.status(),
        layout: this._programLayout ? {
          mode: this._programLayout.mode,
          modeLabel: this._programLayout.modeLabel,
          title: this._programLayout.title,
          filePaths: this._programLayout.filePaths,
          eventFeed: this._eventFeed,
        } : null,
      } : null,
      relays: this.relays ? this.relays.status() : null,
      master: this.master ? {
        ...this.master.status(),
        loadPerCore: (() => {
          try {
            const { hostLoadPerCore } = require('./delivery_qa');
            return hostLoadPerCore();
          } catch { return null; }
        })(),
      } : null,
      middleware: {
        ...(this._middlewareFlags || middlewareStatus()),
        restreamer: this.restreamer ? this.restreamer.status() : null,
        swap: this.swapController ? this.swapController.status() : null,
        rtmpDelivery: this._rtmpDeliveryUrl
          ? this._rtmpDeliveryUrl.replace(/\/live2\/.+$/, '/live2/…')
          : null,
        rtmpHeld: !!this._rtmpHeld,
        studioDual: this._studioDual || null,
      },
      soloStreams: (() => {
        const { soloStreamsEnabled, soloStreamsConfigured } = require('./solo_listings_env');
        return {
          enabled: soloStreamsEnabled(),
          configured: soloStreamsConfigured(),
          started: !!this.soloPublishers?.started,
          seats: this._soloStatusSeats(),
        };
      })(),
    };
  }
}

module.exports = { LiveGridManager, gridTitle };
