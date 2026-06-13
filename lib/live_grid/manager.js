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
const { getFollowedBench } = require('./follows');
const { QuadrantFeeders, generateSlate, quadUrl } = require('./feeders');
const { MasterCompositor } = require('./compositor');
const { MusicDetector, pickAudioQuad } = require('./music_detector');
const { ChatControl } = require('./chat_control');
const { LikeTracker } = require('./chat_perks');
const { QuadRelays, USE_UDP_RELAY } = require('./relays');
const { rtspHasVideo } = require('./rtsp_probe');
const { generateGridSeo, AUDIO_INSTRUCTIONS } = require('./seo');
const { ProgramDirector } = require('./program_director');
const { isAllowedFilePath } = require('./file_sources');
const yt = require('../services/youtube_direct');

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
    this._lastPollerAssignments = [null, null, null, null];
    this._programTick = null;
  }

  async start(o = {}) {
    if (this.running) throw new Error('live grid already running');
    this.running = true;
    this.startedAt = Date.now();

    await new Promise((res, rej) => generateSlate(e => e ? rej(e) : res()));

    let bench = o.bench;
    let refreshBench = null;
    if (!bench) {
      refreshBench = () => getFollowedBench({ roster: o.roster || DEFAULT_ROSTER, exclude: o.exclude || [] });
      bench = await refreshBench();
      if (bench) this.log(`bench from Twitch follows: ${bench.length} channels (live sync on)`);
    }
    this.poller = new LiveGridPoller({ roster: o.roster, bench: bench || undefined, exclude: o.exclude, refreshBench });
    this.feeders = new QuadrantFeeders({ log: this.log });

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

    const { assignments } = await this.poller.pollOnce();
    this._lastPollerAssignments = [...assignments];
    const layout = this._applyProgram(assignments);
    this.feeders.applySources(layout.sources);
    this._lastAssignments = this._sourcesToLogins(layout.sources);
    this._programLayout = layout;

    let output = o.output;
    let verticalOutput = o.verticalOutput || process.env.LIVE_GRID_VERTICAL_OUTPUT || null;
    const frameRate = liveStreamFrameRate();
    const privacy = o.privacyStatus || process.env.LIVE_GRID_PRIVACY || 'public';

    if (!output) {
      const seo = await generateGridSeo(this._lineup(this._lastPollerAssignments));
      if (seo) this.log(`SEO copy generated: "${seo.title}"`);
      const title = o.title || layout.title || seo?.title || gridTitle(this._lastPollerAssignments);
      const description = o.description || seo?.description ||
        `${layout.descriptionPrefix || 'The biggest live moments from the ClipzWorld roster — four streams, one grid, all live.'}\n\n${AUDIO_INSTRUCTIONS}`;

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
      });
      this.broadcast = { ...broadcast, streamId: stream.streamId };
      output = stream.rtmpUrl;
      this.log(`landscape broadcast: ${broadcast.watchUrl}`);

      const verticalMode = String(process.env.LIVE_GRID_VERTICAL || 'auto').toLowerCase();
      if (!verticalOutput && verticalMode !== 'off') {
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
          });
          verticalOutput = vStream.rtmpUrl;
          this.verticalBroadcast = { ...vBroadcast, streamId: vStream.streamId };
          this.log(`vertical broadcast: ${vBroadcast.watchUrl}`);
        } catch (e) {
          this.log(`vertical dual-view skipped: ${e.response?.data?.error?.message || e.message}`);
        }
      }
    }

    if (verticalOutput) this.log(`vertical 9:16 encode → ${verticalOutput.replace(/\/live2\/.+$/, '/live2/…')}`);

    this.relays = USE_UDP_RELAY ? new QuadRelays({ log: this.log }) : null;

    this.audioQuad = this._autoAudioQuad(assignments);
    this.master = new MasterCompositor({
      output,
      verticalOutput,
      logoPath: o.logoPath,
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

    this.caffeinate = spawn('caffeinate', ['-dims'], { stdio: 'ignore' });
    this.log('live grid started');
    return this.status();
  }

  _onChatCommand(cmd) {
    if (cmd.type === 'swap') return this._handleMemberSwap(cmd);
    if (this.audioMode === 'manual') return;
    if (!this._lastAssignments[cmd.quadrant]) return;

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
      const login = this._lastAssignments[cmd.quadrant];
      this.log(`audio → quad${cmd.quadrant + 1} (member: ${cmd.author})`);
      this.chat.postMessage(`⭐ Now hearing ${(login || '').toUpperCase()} (screen ${cmd.quadrant + 1})`)
        .catch(() => {});
    }
  }

  _handleMemberSwap({ quadrant, login, author, isMember }) {
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
    const live = this.poller?.lastLive || {};
    if (!live[login]) {
      this.chat?.postMessage(`${login} isn't live right now`).catch(() => {});
      return;
    }
    const roster = new Set(this.poller.roster);
    const bench = this.poller.bench;
    if (!roster.has(login) && !bench.has(login)) {
      this.chat?.postMessage(`${login} isn't on our roster or bench`).catch(() => {});
      return;
    }
    if (!this.poller.pinQuadrant(quadrant, login)) return;
    this.feeders.setQuadrant(quadrant, login);
    const next = [...this._lastAssignments];
    next[quadrant] = login;
    this._lastAssignments = next;
    this._memberSwapAt.set(author, Date.now());
    this.relays?.restart(quadrant);
    if (!USE_UDP_RELAY) this._scheduleFreezeCheck(quadrant, login);
    this.log(`member swap: quad${quadrant + 1} → ${login} (${author})`);
    this.chat?.postMessage(`⭐ ${author} swapped screen ${quadrant + 1} to ${login.toUpperCase()}`)
      .catch(() => {});
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

  _applyProgram(pollerAssignments) {
    return this.programDirector.layout(pollerAssignments);
  }

  _sourcesChanged(a, b) {
    if (!a || !b || a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) {
      const x = a[i]; const y = b[i];
      if (x === y) continue;
      if (x && y && typeof x === 'object' && typeof y === 'object' && x.type === 'file' && y.type === 'file') {
        if (x.path === y.path && x.label === y.label) continue;
      }
      return true;
    }
    return false;
  }

  _onProgramTick() {
    if (!this.running || !this.programDirector) return;
    const layout = this._applyProgram(this._lastPollerAssignments);
    if (!this._sourcesChanged(layout.sources, this._programLayout?.sources)) return;
    this.log(`program segment change → ${layout.mode}`);
    this._applySourceLayout(layout, this._programLayout?.sources || []);
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
      generateGridSeo(this._lineup(this._lastPollerAssignments))
        .then(seo => yt.updateBroadcastMeta(this.broadcast.broadcastId, {
          title: layout.title || seo?.title || gridTitle(this._lastPollerAssignments),
          description: seo?.description,
        }))
        .catch(e => this.log(`title update failed: ${e.message}`));
    }
  }

  setQuadrantFile(q, filePath, label) {
    if (!Number.isInteger(q) || q < 0 || q > 3) throw new Error('quadrant must be 0-3');
    const abs = path.resolve(filePath);
    if (!isAllowedFilePath(abs)) throw new Error(`file not allowed: ${filePath}`);
    this.feeders.setQuadrantFile(q, abs, label);
    this.relays?.restart(q);
    if (!USE_UDP_RELAY) this._scheduleFreezeCheck(q, null);
    return this.feeders.status()[q];
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
    if (!this._lastAssignments[q] && quadKind !== 'file') {
      this.log(`audio → quad${q + 1} ignored (slate)`);
      return false;
    }
    if (source === 'manual') this.audioMode = 'manual';
    else if (this.audioMode !== 'manual') this.audioMode = source;
    if (this.audioMuted) this._setMuted(false);
    return this._applyAudio(q, source);
  }

  _applyAudio(q, source) {
    if (q === this.audioQuad) return false;
    this.audioQuad = q;
    if (this.master && !this.master.setAudioQuad(q)) this.master.restart();
    this.log(`on-air audio → quad${q + 1} (${this._lastAssignments[q] || 'slate'}, ${source})`);
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
    const layout = this._applyProgram(assignments);
    const sources = layout.sources;
    const changed = this._sourcesChanged(sources, prevSources);
    this.feeders.applySources(sources);
    this._lastAssignments = this._sourcesToLogins(sources);
    this._programLayout = layout;

    const live = this.poller?.lastLive || {};
    const audibleLogin = this._lastAssignments[this.audioQuad];
    const audibleFile = this.feeders?.quads[this.audioQuad]?.kind === 'file';
    if (!audibleLogin && !audibleFile) {
      const next = this._autoAudioQuad(this._lastAssignments);
      if (this._lastAssignments[next] || this.feeders?.quads[next]?.kind === 'file') {
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

    if (!changed) return;

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
      generateGridSeo(this._lineup(assignments))
        .then(seo => yt.updateBroadcastMeta(this.broadcast.broadcastId, {
          title: layout.title || seo?.title || gridTitle(assignments),
          description: seo?.description,
        }))
        .catch(e => this.log(`title update failed: ${e.message}`));
    }
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
      audio: {
        quadrant: this.audioQuad + 1,
        login: this._lastAssignments[this.audioQuad] || null,
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
        } : null,
      } : null,
      relays: this.relays ? this.relays.status() : null,
      master: this.master ? this.master.status() : null,
    };
  }
}

module.exports = { LiveGridManager, gridTitle };
