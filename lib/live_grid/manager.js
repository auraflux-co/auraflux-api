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
const { resolveAvatarOverlay, shouldUseAvatarPip } = require('./avatar_overlay');
const { QuadrantFeeders, generateSlate, quadUrl } = require('./feeders');
const { MasterCompositor } = require('./compositor');
const { resolveVerticalStream } = require('./dual_broadcast');
const { MusicDetector, pickAudioQuad } = require('./music_detector');
const { ChatControl } = require('./chat_control');
const { LikeTracker } = require('./chat_perks');
const { QuadRelays, USE_UDP_RELAY } = require('./relays');
const { rtspHasVideo } = require('./rtsp_probe');
const { generateGridSeo, formatAudioInstructions, displayName, AUDIO_INSTRUCTIONS } = require('./seo');
const { generateLiveThumbnail } = require('./live_thumbnail');
const { ProgramDirector } = require('./program_director');
const { pickEventFeed } = require('./event_feed_picker');
const { isAllowedFilePath } = require('./file_sources');
const yt = require('../services/youtube_direct');
const {
  loadPrepared, savePrepared, clearPrepared, scheduleAheadEnabled,
  preparedIsStale, scheduledStartReady, gridStartIsoFromMinutes,
} = require('./prepared_broadcast');

const PROGRAM_TICK_MS = parseInt(process.env.LIVE_GRID_PROGRAM_TICK_MS || '60000', 10);

const AUDIO_LEAD_RATIO = 1.2;
const CHAT_SWITCH_COOLDOWN_MS = 30_000;
const MEMBER_SWAP_COOLDOWN_MS = parseInt(process.env.LIVE_GRID_MEMBER_SWAP_COOLDOWN_MS || '1800000', 10);
const FREEZE_FALLBACK_MS = parseInt(process.env.LIVE_GRID_FREEZE_FALLBACK_MS || '15000', 10);
const SWAP_RESTART_DEBOUNCE_MS = 5_000;
const SWAP_RESTART = String(process.env.LIVE_GRID_SWAP_RESTART || 'off').toLowerCase() === 'on';
const MEMBER_ONLY_AUDIO = String(process.env.LIVE_GRID_MEMBER_ONLY_AUDIO || 'on').toLowerCase() !== 'off';
const SWAP_REQUIRES_LIKES = String(process.env.LIVE_GRID_SWAP_REQUIRES_LIKES || 'on').toLowerCase() !== 'off';

function gridTitle(assignments) {
  const live = assignments.filter(Boolean);
  if (!live.length) return 'ClipzWorld Live Grid';
  const lead = live.slice(0, 2).join(', ');
  const more = live.length > 2 ? ` +${live.length - 2}` : '';
  return `🔴 LIVE: ${lead}${more} — ClipzWorld Grid`;
}

function liveStreamFrameRate() {
  const fps = parseInt(process.env.LIVE_GRID_FPS || '60', 10);
  return `${fps}fps`;
}

class LiveGridManager {
  constructor(opts = {}) {
    this.log = opts.log || ((m) => console.log(`[live-grid:mgr] ${m}`));
    this.opts = opts;
    this.poller = null;
    this.feeders = null;
    this.relays = null;
    this.master = null;
    this.caffeinate = null;
    this.broadcast = null;
    this.verticalBroadcast = null;
    this.startedAt = null;
    this.running = false;
    this._lastAssignments = [null, null, null, null];
    this._freezeTimers = [null, null, null, null];
    this._restartTimer = null;
    this.audioMode = 'auto';
    this.audioQuad = 0;
    this.chat = null;
    this.likeTracker = null;
    this._lastChatSwitch = 0;
    this._memberSwapAt = new Map();
    this._swapUnlocked = false;
    this.musicDetector = null;
    this._musicFlags = [false, false, false, false];
    this.audioMuted = false;
    this.programDirector = null;
    this._programLayout = null;
    this._eventFeed = null;
    /** @type {Array<{ type: 'channel'|'url'|'file', login?, url?, path?, label?, title? }|null>} */
    this.operatorLocks = [null, null, null, null];
    this._lastPollerAssignments = [null, null, null, null];
    this._programTick = null;
    this.opts = {};
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
        if (!usePlatform) return followsOnly;
        const platform = await fetchPlatformTopLive();
        return mergePlatformBench({ roster: rosterList, follows: followsOnly, platform });
      };
      bench = await refreshBench();
      if (bench?.length) {
        this.log(`bench: ${bench.length} channels (${allFollowsOnly.length} follows, ${followsOnly.length} bench-eligible + platform)`);
      }
    }
    this.poller = new LiveGridPoller({ roster: o.roster, bench: bench || undefined, exclude: o.exclude, refreshBench });
    if (allFollowsOnly.length) this.poller.allFollows = allFollowsOnly;
    if (followsOnly.length) this.poller.benchFollows = followsOnly;

    this.programDirector = new ProgramDirector({
      log: this.log,
      mode: o.programMode || process.env.LIVE_GRID_PROGRAM_MODE || 'auto',
    });
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

  /** Create YouTube stream + broadcast, apply SEO/thumbnail. Returns { output, verticalOutput, seo }. */
  async _createYoutubeBroadcast(o, layout, { scheduledStartTime } = {}) {
    const frameRate = liveStreamFrameRate();
    const privacy = o.privacyStatus || process.env.LIVE_GRID_PRIVACY || 'public';
    const seoCtx = this._buildSeoContext(layout);
    const seo = await generateGridSeo(seoCtx);
    if (seo) this.log(`SEO copy generated: "${seo.title}"`);
    const title = o.title || seo?.title || layout.title || gridTitle(this._lastPollerAssignments);
    const description = o.description || seo?.description ||
      `${layout.descriptionPrefix || 'The biggest live moments from the ClipzWorld roster — four streams, one grid, all live.'}\n\n${formatAudioInstructions('\n')}`;

    const stream = await yt.createLiveStream({
      title: 'ClipzWorld Live Grid landscape',
      frameRate,
      resolution: '1080p',
    });
    const broadcast = await yt.createLiveBroadcast({
      title,
      description,
      privacyStatus: privacy,
      streamId: stream.streamId,
      scheduledStartTime: scheduledStartTime || undefined,
    });
    this.broadcast = { ...broadcast, streamId: stream.streamId };
    const output = stream.rtmpUrl;
    this.log(`landscape broadcast: ${broadcast.watchUrl}${scheduledStartTime ? ` (scheduled ${scheduledStartTime})` : ''}`);

    if (seo) {
      await this._applyYoutubeSeo(seo).catch(e => this.log(`YouTube SEO apply failed: ${e.message}`));
    }

    let verticalOutput = null;
    const { verticalOutput: presetVertical, createVerticalBroadcast, legacyDual } =
      resolveVerticalStream({ verticalOutput: o.verticalOutput });
    verticalOutput = presetVertical;

    if (!verticalOutput && createVerticalBroadcast) {
      try {
        const vStream = await yt.createLiveStream({
          title: 'ClipzWorld Live Grid vertical',
          frameRate,
          resolution: '1080p',
        });
        const vBroadcast = await yt.createLiveBroadcast({
          title: `${title.slice(0, 88)} (Vertical)`,
          description,
          privacyStatus: privacy,
          streamId: vStream.streamId,
          scheduledStartTime: scheduledStartTime || undefined,
        });
        verticalOutput = vStream.rtmpUrl;
        this.verticalBroadcast = { ...vBroadcast, streamId: vStream.streamId };
        this.log(`legacy dual broadcast (vertical): ${vBroadcast.watchUrl}`);
      } catch (e) {
        this.log(`legacy vertical broadcast skipped: ${e.response?.data?.error?.message || e.message}`);
      }
    } else if (!legacyDual && !presetVertical) {
      this.log('mobile portrait: YouTube native dual-format from landscape ingest (CPD-1029)');
    }

    return { output, verticalOutput, seo, title, description };
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
    const { output, verticalOutput, seo } = await this._createYoutubeBroadcast(o, layout, { scheduledStartTime });

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
  async setProgramMode(mode) {
    if (!this.running) throw new Error('live grid not running');
    if (!mode) throw new Error('mode required');
    this.programDirector.mode = mode;
    this.opts.programMode = mode;
    const layout = await this._applyProgram(this._lastPollerAssignments);
    this._applySourceLayout(layout, this._programLayout?.sources || []);
    this.log(`program mode hot-switch → ${layout.mode}`);
    return {
      mode: layout.mode,
      modeLabel: layout.modeLabel,
      title: layout.title,
    };
  }

  async start(o = {}) {
    if (this.running) throw new Error('live grid already running');
    this.running = true;
    this.startedAt = Date.now();
    this.opts = o || {};

    await new Promise((res, rej) => generateSlate(e => e ? rej(e) : res()));

    const { layout, assignments } = await this._resolveLaunchLayout(o);
    this.feeders = new QuadrantFeeders({ log: this.log });
    this.feeders.applySources(layout.sources);
    this._programLayout = layout;

    let output = o.output;
    const { verticalOutput: presetVertical, createVerticalBroadcast, legacyDual } =
      resolveVerticalStream({ verticalOutput: o.verticalOutput });
    let verticalOutput = presetVertical;

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
    }

    if (verticalOutput) {
      this.log(`legacy 9:16 ffmpeg encode → ${verticalOutput.replace(/\/live2\/.+$/, '/live2/…')}`);
    }

    this.relays = USE_UDP_RELAY ? new QuadRelays({ log: this.log }) : null;

    this.audioQuad = this._autoAudioQuad(assignments);
    const avatarOverlay = resolveAvatarOverlay({
      path: o.avatarOverlay,
      avatarOverlay: o.avatarOverlay,
      programMode: layout.mode,
    });
    if (avatarOverlay) this.log(`avatar PIP: ${path.basename(avatarOverlay)}`);
    else if (shouldUseAvatarPip(layout.mode, o) === false && String(process.env.LIVE_GRID_AVATAR_PIP || 'auto').toLowerCase() !== 'off') {
      this.log(`avatar PIP off (${layout.mode} — co-stream quadrants must stay clear)`);
    }
    this.master = new MasterCompositor({
      output,
      verticalOutput,
      logoPath: o.logoPath,
      avatarOverlay,
      log: this.log,
      audioQuad: this.audioQuad,
    });
    await new Promise(r => setTimeout(r, 8000));
    if (this.relays) {
      this.relays.startAll();
      await new Promise(r => setTimeout(r, 2500));
    }
    this.master.start();

    this.poller.on('poll', ({ assignments: next }) => this._onAssignments(next));
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

    if (process.platform === 'darwin') {
      this.caffeinate = spawn('caffeinate', ['-dims'], { stdio: 'ignore' });
    }
    this.log('live grid started');
    return this.status();
  }

  _onChatCommand(cmd) {
    if (cmd.type === 'swap') {
      this._handleMemberSwap(cmd).catch(e => this.log(`member swap failed: ${e.message}`));
      return;
    }
    if (this.audioMode === 'manual') return;
    const quadKind = this.feeders?.quads[cmd.quadrant]?.kind;
    if (!this._lastAssignments[cmd.quadrant] && quadKind !== 'url' && quadKind !== 'file') return;

    // CPD-1005 policy: audio is a MEMBER perk only — no public voting.
    if (MEMBER_ONLY_AUDIO && !cmd.isMember) {
      this.chat?.postMessage('⭐ Audio is a member perk — subscribe to the channel, then !listen 1-4 picks your screen instantly')
        .catch(() => {});
      return;
    }

    if (!cmd.isMember) return;

    if (Date.now() - this._lastChatSwitch < CHAT_SWITCH_COOLDOWN_MS) return;
    if (this.setAudio(cmd.quadrant, 'chat')) {
      this._lastChatSwitch = Date.now();
      const name = this._audioSourceName(cmd.quadrant);
      this.log(`audio → quad${cmd.quadrant + 1} (member: ${cmd.author})`);
      this.chat.postMessage(`⭐ Now hearing ${String(name).toUpperCase()} (screen ${cmd.quadrant + 1})`)
        .catch(() => {});
    }
  }

  async _handleMemberSwap({ quadrant, login, author, isMember }) {
    if (!isMember) {
      this.chat?.postMessage('⭐ !swap is members only — subscribe to the channel first')
        .catch(() => {});
      return;
    }
    if (SWAP_REQUIRES_LIKES && !this._swapUnlocked) {
      this.chat?.postMessage('⭐ !swap unlocks when we hit the next like milestone — like the stream + be a member!')
        .catch(() => {});
      return;
    }
    const last = this._memberSwapAt.get(author) || 0;
    if (Date.now() - last < MEMBER_SWAP_COOLDOWN_MS) {
      this.chat?.postMessage('⏳ Member swap cooldown — try again later').catch(() => {});
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
    if (this.audioMode === 'manual') {
      if (flags[this.audioQuad]) this.log(`🎵 MUSIC ON AIR (quad${this.audioQuad + 1}) — manual pin respected, not switching`);
      return;
    }
    const live = this.poller?.lastLive || {};
    const onAirMusic = flags[this.audioQuad];
    if (!onAirMusic && !this.audioMuted) return;

    const pick = pickAudioQuad(this._lastAssignments, live, flags);
    if (pick.quad >= 0) {
      if (this.audioMuted) this._setMuted(false);
      if (pick.quad !== this.audioQuad) {
        this.log(`🎵 music guard: leaving quad${this.audioQuad + 1} for clean quad${pick.quad + 1}`);
        this._applyAudio(pick.quad, 'music-guard');
      }
    } else if (pick.mute && !this.audioMuted) {
      this.log('🎵 music guard: every live quadrant is playing music — muting the mix');
      this._setMuted(true);
    }
  }

  _setMuted(muted) {
    this.audioMuted = !!muted;
    if (this.master && !this.master.setMuted(this.audioMuted)) this.master.restart();
    this.log(this.audioMuted ? 'mix MUTED (music guard)' : 'mix unmuted');
  }

  _sourcesToLogins(sources) {
    return sources.map(s => (typeof s === 'string' ? s : null));
  }

  _mergeOperatorLocks(sources) {
    const out = [...(sources || [])];
    while (out.length < 4) out.push(null);
    for (let q = 0; q < 4; q++) {
      const lock = this.operatorLocks[q];
      if (!lock) continue;
      if (lock.type === 'channel') out[q] = lock.login;
      else if (lock.type === 'url') {
        out[q] = { type: 'url', url: lock.url, label: lock.label || 'EVENT', title: lock.title || lock.login || '' };
      } else if (lock.type === 'file') {
        out[q] = { type: 'file', path: lock.path, label: lock.label || 'CLIPZWORLD' };
      }
    }
    return out;
  }

  async _applyProgram(pollerAssignments) {
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
    layout.sources = this._mergeOperatorLocks(layout.sources);
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
    this._applyProgram(this._lastPollerAssignments)
      .then((layout) => {
        if (!this.running) return;
        if (!this._sourcesChanged(layout.sources, this._programLayout?.sources)) return;
        this.log(`program segment change → ${layout.mode}`);
        this._applySourceLayout(layout, this._programLayout?.sources || []);
      })
      .catch(e => this.log(`program tick failed: ${e.message}`));
  }

  _applySourceLayout(layout, prevSources) {
    const sources = layout.sources;
    this.feeders.applySources(sources);
    this._lastAssignments = this._sourcesToLogins(sources);
    this._programLayout = layout;

    for (let q = 0; q < 4; q++) {
      if (!this._sourcesChanged([sources[q]], [prevSources[q]])) continue;
      this.relays?.restart(q);
      if (!USE_UDP_RELAY) this._scheduleFreezeCheck(q, this._lastAssignments[q]);
    }

    if (this.broadcast) {
      this._applyYoutubeSeoFromLayout(layout)
        .catch(e => this.log(`YouTube SEO update failed: ${e.message}`));
    }
  }

  _buildSeoContext(layout = this._programLayout) {
    const live = this.poller?.lastLive || {};
    const streamers = [];
    const sources = layout?.sources || [];
    const eventFeed = layout?.eventFeed || this._eventFeed;

    for (let q = 0; q < 4; q++) {
      const src = sources[q];
      const lock = this.operatorLocks[q];
      const login = this._lastAssignments?.[q] || (lock?.type === 'channel' ? lock.login : null);
      if (src && typeof src === 'object' && src.type === 'url') {
        const slug = lock?.login || src.label?.toLowerCase?.() || eventFeed?.channel || 'event';
        streamers.push({
          login: slug,
          displayName: displayName(slug),
          viewers: live[slug] || eventFeed?.viewers || 0,
          role: q === 0 ? 'event feed' : 'feed',
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

    const headline = layout?.mode === 'news_desk'
      ? (this.opts?.headline || 'ClipzWorld News Desk — Breaking & Analysis')
      : (eventFeed?.title
        || layout?.title?.replace(/^🔴 LIVE:\s*/i, '').split('|')[0]?.trim()
        || layout?.modeLabel
        || 'ClipzWorld Watch Party');

    return {
      streamers,
      programMode: layout?.mode,
      headline,
      subline: layout?.modeLabel || 'Multi-Stream Watch Party',
    };
  }

  async _applyYoutubeSeo(seo) {
    if (!this.broadcast?.broadcastId || !seo?.title) return;
    let thumbnailPath = null;
    if (String(process.env.LIVE_GRID_LIVE_THUMBNAIL || 'on').toLowerCase() !== 'off') {
      const thumb = await generateLiveThumbnail({
        headline: seo.thumbnailHeadline || seo.title.replace(/^🔴 LIVE:\s*/i, '').slice(0, 60),
        subline: seo.thumbnailSubline,
        programMode: this._programLayout?.mode || this._buildSeoContext().programMode,
        streamers: this._buildSeoContext().streamers,
      });
      if (thumb.ok) {
        thumbnailPath = thumb.path;
        this.log(`live thumbnail: ${path.basename(thumb.path)}`);
      } else if (thumb.error) {
        this.log(`live thumbnail skipped: ${thumb.error}`);
      }
    }
    const result = await yt.applyLiveBroadcastSeo(this.broadcast.broadcastId, seo, {
      thumbnailPath,
      log: (m) => this.log(m),
    });
    if (result.thumbnail) this.log('YouTube custom thumbnail set');
    if (result.tags) this.log(`YouTube tags set (${seo.tags?.length || 0})`);
  }

  async _applyYoutubeSeoFromLayout(layout) {
    const seo = await generateGridSeo(this._buildSeoContext(layout));
    if (!seo) return;
    const title = layout?.title || seo.title;
    await this._applyYoutubeSeo({ ...seo, title });
  }

  setQuadrantFile(q, filePath, label) {
    if (!Number.isInteger(q) || q < 0 || q > 3) throw new Error('quadrant must be 0-3');
    const abs = path.resolve(filePath);
    if (!isAllowedFilePath(abs)) throw new Error(`file not allowed: ${filePath}`);
    this.operatorLocks[q] = { type: 'file', path: abs, label: label || path.basename(abs) };
    this.feeders.setQuadrantFile(q, abs, label);
    this.relays?.restart(q);
    if (!USE_UDP_RELAY) this._scheduleFreezeCheck(q, null);
    if (this._programLayout?.sources) {
      this._programLayout.sources[q] = { type: 'file', path: abs, label: label || path.basename(abs) };
      this._lastAssignments = this._sourcesToLogins(this._programLayout.sources);
    }
    return this.feeders.status()[q];
  }

  setQuadrantUrl(q, feedUrl, label = 'EVENT', opts = {}) {
    if (!Number.isInteger(q) || q < 0 || q > 3) throw new Error('quadrant must be 0-3');
    this.feeders.setQuadrantUrl(q, feedUrl, label);
    const slug = opts.login || String(feedUrl).split('/').filter(Boolean).pop();
    this.operatorLocks[q] = { type: 'url', url: feedUrl, label, title: opts.title, login: slug };
    this.relays?.restart(q);
    if (!USE_UDP_RELAY) this._scheduleFreezeCheck(q, null);
    if (this._programLayout?.sources) {
      this._programLayout.sources[q] = { type: 'url', url: feedUrl, label, title: opts.title || '' };
      this._lastAssignments = this._sourcesToLogins(this._programLayout.sources);
    }
    return this.feeders.status()[q];
  }

  /** Operator lock — Twitch channel on quadrant q (survives poller ticks). */
  setQuadrantChannel(q, login) {
    if (!Number.isInteger(q) || q < 0 || q > 3) throw new Error('quadrant must be 0-3');
    const slug = String(login || '').trim().toLowerCase();
    if (!slug) throw new Error('login required');
    this.operatorLocks[q] = { type: 'channel', login: slug };
    this.poller?.pinQuadrant(q, slug);
    this.feeders.setQuadrant(q, slug);
    this.relays?.restart(q);
    if (!USE_UDP_RELAY) this._scheduleFreezeCheck(q, slug);
    if (this._programLayout?.sources) {
      this._programLayout.sources[q] = slug;
      this._lastAssignments = this._sourcesToLogins(this._programLayout.sources);
    }
    this.log(`operator lock Q${q + 1} → ${slug}`);
    return this.feeders.status()[q];
  }

  clearQuadrantLock(q) {
    if (!Number.isInteger(q) || q < 0 || q > 3) throw new Error('quadrant must be 0-3');
    this.operatorLocks[q] = null;
    this.poller?.clearPin(q);
    this.log(`operator lock cleared Q${q + 1}`);
    return { ok: true };
  }

  setOperatorMode(enabled) {
    if (!this.poller) throw new Error('grid not started');
    this.poller.operatorMode = !!enabled;
    this.log(this.poller.operatorMode
      ? 'operator mode ON — you control swaps; auto only drops offline streamers'
      : 'auto pilot ON — bench fills empty quadrants and viewer swaps resume');
    return { operatorMode: this.poller.operatorMode };
  }

  _lineup(assignments) {
    const live = this.poller?.lastLive || {};
    return assignments.filter(Boolean).map(login => ({ login, viewers: live[login] || 0 }));
  }

  _autoAudioQuad(assignments) {
    const live = this.poller?.lastLive || {};
    const clean = pickAudioQuad(assignments, live, this._musicFlags);
    if (clean.quad >= 0) return clean.quad;
    let best = -1, bestViewers = -1;
    assignments.forEach((login, q) => {
      if (login && (live[login] || 0) > bestViewers) { best = q; bestViewers = live[login] || 0; }
    });
    return best >= 0 ? best : 0;
  }

  setAudio(quadrant, source = 'manual') {
    if (quadrant === 'auto') {
      this.audioMode = 'auto';
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
    if (source === 'manual') this.audioMode = 'manual';
    else if (this.audioMode !== 'manual') this.audioMode = source;
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
    if (this.master && !this.master.setAudioQuad(q)) this.master.restart();
    this.log(`on-air audio → quad${q + 1} (${this._audioSourceName(q)}, ${source})`);
    return true;
  }

  _scheduleFreezeCheck(q, login) {
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
        this.feeders.applySources(sources);
        this._lastAssignments = this._sourcesToLogins(sources);
        this._programLayout = layout;

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
        } else if (this.audioMode === 'auto') {
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
            this.relays?.restart(q);
            if (!USE_UDP_RELAY) this._scheduleFreezeCheck(q, this._lastAssignments[q]);
          }

          if (SWAP_RESTART && !USE_UDP_RELAY) {
            clearTimeout(this._restartTimer);
            this._restartTimer = setTimeout(() => {
              if (!this.running || !this.master) return;
              this.master.restart();
            }, SWAP_RESTART_DEBOUNCE_MS);
          }

          if (this.broadcast) {
            this._applyYoutubeSeoFromLayout(layout)
              .catch(e => this.log(`YouTube SEO update failed: ${e.message}`));
          }
        }
      })
      .catch(e => this.log(`assignment apply failed: ${e.message}`));
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    for (const t of this._freezeTimers) clearTimeout(t);
    clearTimeout(this._restartTimer);
    if (this._programTick) clearInterval(this._programTick);
    this._programTick = null;
    this.poller?.stop();
    this.chat?.stop();
    this.likeTracker?.stop();
    this.musicDetector?.stop();
    this.master?.stop();
    this.relays?.stopAll();
    this.feeders?.stopAll();
    if (this.caffeinate) { try { this.caffeinate.kill(); } catch (_) {} }
    if (this.broadcast) {
      try { await yt.endLiveBroadcast(this.broadcast.broadcastId); this.log('landscape broadcast ended'); }
      catch (e) { this.log(`endLiveBroadcast failed: ${e.response?.data?.error?.message || e.message}`); }
    }
    if (this.verticalBroadcast) {
      try { await yt.endLiveBroadcast(this.verticalBroadcast.broadcastId); this.log('vertical broadcast ended'); }
      catch (e) { this.log(`vertical endLiveBroadcast failed: ${e.response?.data?.error?.message || e.message}`); }
    }
    this.log('live grid stopped');
  }

  status() {
    return {
      running: this.running,
      uptimeSec: this.startedAt && this.running ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      broadcast: this.broadcast ? { id: this.broadcast.broadcastId, watchUrl: this.broadcast.watchUrl } : null,
      verticalBroadcast: this.verticalBroadcast
        ? { id: this.verticalBroadcast.broadcastId, watchUrl: this.verticalBroadcast.watchUrl } : null,
      quadrants: this.feeders ? this.feeders.status() : [],
      operatorLocks: this.operatorLocks.map((lock, i) => lock ? { quadrant: i + 1, ...lock } : null).filter(Boolean),
      audio: {
        quadrant: this.audioQuad + 1,
        login: this._lastAssignments[this.audioQuad] || null,
        label: this.feeders?.status()?.[this.audioQuad]?.displayName
          || this.feeders?.status()?.[this.audioQuad]?.label
          || null,
        mode: this.audioMode,
        chatControl: !!this.chat?.running,
        muted: this.audioMuted,
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
      master: this.master ? this.master.status() : null,
    };
  }
}

module.exports = { LiveGridManager, gridTitle };
