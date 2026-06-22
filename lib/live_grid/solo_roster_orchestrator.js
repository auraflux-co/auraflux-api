'use strict';
/**
 * CPD-1067 — Solo roster orchestrator: poll source live → per-slot YouTube mirror.
 */

const fs = require('fs');
const path = require('path');
const { twitchChannelLive, kickChannelLive } = require('./stream_probe');
const { rtspHasVideo } = require('./rtsp_probe');
const { quadUrl } = require('./feeders');
const {
  localFleetSlots,
  currentFleetId,
  isSlotPaused,
} = require('./solo_roster_fleet');
const {
  applyLoginSlotMap,
  getBinding,
  listingFromSlot,
  updatePoolSlotListing,
} = require('./solo_streamer_registry');
const { readSoloListingForPoolSlot } = require('./solo_listings_env');
const { waitForYoutubeLive, goLiveWaitEnabled } = require('./youtube_go_live');
const yt = require('../services/youtube_direct');

const POLL_MS = parseInt(process.env.LIVE_GRID_FLEET_POLL_MS || '45000', 10);
const RTSP_READY_MS = parseInt(process.env.LIVE_GRID_FLEET_RTSP_WAIT_MS || '30000', 10);
const KICK_RTSP_READY_MS = parseInt(
  process.env.LIVE_GRID_FLEET_KICK_RTSP_WAIT_MS || String(Math.max(RTSP_READY_MS, 90000)),
  10,
);
const SOLO_ENCODER_WAIT_MS = parseInt(process.env.LIVE_GRID_FLEET_SOLO_WAIT_MS || '120000', 10);

function slotGoLivePrivacy(slotDef) {
  if (slotDef?.testLane) return 'private';
  return process.env.LIVE_GRID_FLEET_DEFAULT_PRIVACY || 'public';
}

function statePath() {
  const dir = process.env.LIVE_GRID_RESUME_DIR
    || (process.env.RENDER ? '/app/tmp' : path.join(__dirname, '..', '..', 'data'));
  return path.join(dir, 'solo_roster_orchestrator.json');
}

class SoloRosterOrchestrator {
  /** @param {import('./manager')} manager */
  constructor(manager, opts = {}) {
    this.manager = manager;
    this.log = opts.log || manager.log.bind(manager);
    this.fleetId = opts.fleetId || currentFleetId();
    this.slots = localFleetSlots(this.fleetId);
    /** @type {Map<number, { phase: string, login: string, broadcastId?: string }>} */
    this._slotState = new Map();
    this._pollTimer = null;
    this._tickInFlight = false;
    this._loadState();
  }

  _loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
      for (const row of raw.slots || []) {
        this._slotState.set(row.localIndex, row);
      }
    } catch (e) {
      this.log(`fleet state load failed (starting fresh): ${e.message}`);
    }
  }

  _saveState() {
    try {
      const slots = this.slots.map((s) => {
        const st = this._slotState.get(s.localIndex) || { phase: 'idle', login: s.login };
        return {
          slot: s.slot,
          localIndex: s.localIndex,
          login: s.login,
          phase: st.phase,
          broadcastId: st.broadcastId || null,
        };
      });
      fs.mkdirSync(path.dirname(statePath()), { recursive: true });
      fs.writeFileSync(statePath(), `${JSON.stringify({
        updatedAt: new Date().toISOString(),
        fleetId: this.fleetId,
        slots,
      }, null, 2)}\n`);
    } catch (e) {
      this.log(`fleet state save failed: ${e.message}`);
    }
  }

  async start() {
    process.env.LIVE_GRID_SOLO_STREAMS = 'on';
    process.env.LIVE_GRID_SOLO_STREAMER_LOCK = 'on';
    process.env.LIVE_GRID_MAIN_ENCODE = 'off';

    const activeSlots = [];
    for (const s of this.slots) {
      const listing = listingFromSlot(s.localPool);
      if (!listing?.rtmpUrl) {
        this.log(`pool slot ${s.localPool} (${s.login}) missing LIVE_GRID_SOLO_${s.localPool}_RTMP_URL — skipped until provisioned`);
        continue;
      }
      activeSlots.push(s);
    }
    if (!activeSlots.length) {
      throw new Error('no fleet slots have YouTube listings configured');
    }
    this.slots = activeSlots;
    await this._validateKickRoster();
    const activeSlotMap = Object.fromEntries(activeSlots.map((s) => [s.login, s.localPool]));
    applyLoginSlotMap(activeSlotMap, activeSlots.map((s) => s.login));

    for (const s of this.slots) {
      this.manager.feeders.setQuadrant(s.localIndex, null);
      this._slotState.set(s.localIndex, { phase: 'idle', login: s.login });
    }

    if (!this.manager.soloPublishers) {
      const { SoloPublishers } = require('./solo_publishers');
      this.manager.soloPublishers = new SoloPublishers({ log: (m) => this.log(m) });
    }
    this.manager.soloPublishers.stopped = false;
    this.manager.soloPublishers.started = true;

    await this.tick();
    this._pollTimer = setInterval(() => {
      this.tick().catch((e) => this.log(`fleet tick failed: ${e.message}`));
    }, POLL_MS);
    this._pollTimer.unref?.();
    this.log(`solo roster orchestrator started — ${this.slots.length} slots, poll ${POLL_MS / 1000}s`);
    this._saveState();
    return { ok: true, slots: this.slots.length, fleetId: this.fleetId };
  }

  stop() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async probeSlotLive(slotDef) {
    if (isSlotPaused(slotDef)) return false;
    if (slotDef.platform === 'kick') {
      return kickChannelLive(slotDef.kickSlug || slotDef.login);
    }
    return twitchChannelLive(slotDef.login);
  }

  async _validateKickRoster() {
    const { fetchKickChannelApi } = require('../clients/kick_live_resolver');
    for (const s of this.slots) {
      if (s.platform !== 'kick') continue;
      const slug = String(s.kickSlug || s.login || '').trim().toLowerCase();
      if (!slug) throw new Error(`fleet slot ${s.slot}: missing kickSlug`);
      try {
        const data = await fetchKickChannelApi(slug);
        if (!data) {
          throw new Error(
            `fleet slot ${s.slot}: kick.com/${slug} not found — set kickSlug to the exact Kick channel slug (e.g. n3on not neon)`,
          );
        }
        const apiSlug = String(data.slug || slug).toLowerCase();
        if (apiSlug !== slug) {
          this.log(`fleet slot ${s.slot}: roster kickSlug ${slug} → Kick channel slug ${apiSlug}`);
        }
      } catch (e) {
        if (/not found/i.test(e.message)) throw e;
        this.log(`fleet slot ${s.slot}: Kick roster verify skipped (${e.message}) — will probe at tick`);
      }
    }
  }

  _feederIngestReady(q) {
    const st = this.manager.feeders?.status()?.[q];
    if (!st || !(st.pids?.length || 0)) return false;
    // Kick HLS → kind url; Twitch streamlink → kind channel. Both are real ingest (not slate).
    return st.kind === 'url' || st.kind === 'channel';
  }

  async _seatFeeder(slotDef) {
    const q = slotDef.localIndex;
    if (slotDef.platform === 'kick') {
      const slug = slotDef.kickSlug || slotDef.login;
      await this.manager.setQuadrantKick(q, slug, {
        label: slotDef.login,
        lockWhenOffline: false,
        skipSoloNudge: true,
      });
      return;
    }
    this.manager.feeders.setQuadrant(q, slotDef.login);
  }

  _rtspWaitMs(slotDef) {
    return slotDef?.platform === 'kick' ? KICK_RTSP_READY_MS : RTSP_READY_MS;
  }

  async _waitFeederReady(q, slotDef) {
    const url = quadUrl(q);
    const waitMs = this._rtspWaitMs(slotDef);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (this._feederIngestReady(q) && await rtspHasVideo(url, 4000)) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return this._feederIngestReady(q) && await rtspHasVideo(url, 4000);
  }

  async _waitSoloEncoderReady(q) {
    const deadline = Date.now() + SOLO_ENCODER_WAIT_MS;
    while (Date.now() < deadline) {
      const proc = this.manager.soloPublishers?.procs?.[q];
      if (proc && proc.exitCode == null && proc.killed !== true) {
        if (await rtspHasVideo(quadUrl(q), 3000)) return true;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    const proc = this.manager.soloPublishers?.procs?.[q];
    return !!(proc && proc.exitCode == null && proc.killed !== true);
  }

  async _healKickIngest(slotDef) {
    const q = slotDef.localIndex;
    const slug = slotDef.kickSlug || slotDef.login;
    this.log(`slot ${slotDef.slot} @${slotDef.login} feeder on slate — re-seating Kick HLS ingest`);
    await this.manager.setQuadrantKick(q, slug, {
      label: slotDef.login,
      lockWhenOffline: false,
      skipSoloNudge: true,
    });
  }

  async _ensureBroadcast(slotDef) {
    const listing = readSoloListingForPoolSlot(slotDef.localPool);
    if (!listing?.streamId) throw new Error(`slot ${slotDef.localPool} missing stream id`);
    let bid = listing.broadcastId;
    let reusable = bid ? await this.manager._canReuseBroadcastId(bid) : false;
    if (!reusable && yt.isConnected()) {
      const { buildSoloLiveSeo } = require('./solo_seo');
      const seo = buildSoloLiveSeo({
        login: slotDef.login,
        fleetSlot: slotDef.slot,
        streamerLock: true,
      });
      const created = await yt.createLiveBroadcast({
        title: seo.title,
        description: seo.description,
        privacyStatus: slotGoLivePrivacy(slotDef) === 'public' ? 'unlisted' : slotGoLivePrivacy(slotDef),
        streamId: listing.streamId,
      });
      bid = created.broadcastId;
      updatePoolSlotListing(slotDef.localPool, {
        broadcastId: bid,
        watchUrl: created.watchUrl,
        rtmpUrl: listing.rtmpUrl,
        streamId: listing.streamId,
        label: slotDef.login,
      });
      const binding = getBinding(slotDef.login);
      if (binding) {
        binding.broadcastId = bid;
        binding.watchUrl = created.watchUrl;
        const { saveRegistry, loadRegistry } = require('./solo_streamer_registry');
        const reg = loadRegistry(true);
        reg.bindings[slotDef.login] = binding;
        saveRegistry(reg);
      }
      this.log(`slot ${slotDef.slot} @${slotDef.login} fresh listing → ${created.watchUrl}`);
    }
    return bid;
  }

  async startSlot(slotDef) {
    if (isSlotPaused(slotDef)) {
      this.log(`slot ${slotDef.slot} @${slotDef.login} paused — skip start (${slotDef.pausedReason || 'roster'})`);
      return;
    }
    const q = slotDef.localIndex;
    const st = this._slotState.get(q) || { phase: 'idle', login: slotDef.login };
    if (st.phase === 'live') return;
    const resuming = st.phase === 'starting';
    if (!resuming) {
      st.phase = 'starting';
      st.login = slotDef.login;
      this._slotState.set(q, st);
      this.log(`slot ${slotDef.slot} @${slotDef.login} source live → starting`);
    }

    try {
      if (!resuming || !st.broadcastId) {
        await this._seatFeeder(slotDef);
        const ingestOk = await this._waitFeederReady(q, slotDef);
        if (!ingestOk) {
          this.log(`slot ${slotDef.slot} Kick/Twitch ingest not ready (still slate?) — will retry next poll`);
          st.phase = 'idle';
          this._slotState.set(q, st);
          return;
        }
      }

      if (!st.broadcastId) {
        st.broadcastId = await this._ensureBroadcast(slotDef);
        this._slotState.set(q, st);
      }
      const broadcastId = st.broadcastId;

      this.manager.soloPublishers.start(q, slotDef.login);

      const soloOk = await this._waitSoloEncoderReady(q);
      if (!soloOk) {
        this.log(`slot ${slotDef.slot} solo RTMP encoder not ready — staying starting, retry next poll`);
        st.phase = 'starting';
        this._slotState.set(q, st);
        this._saveState();
        return;
      }

      if (goLiveWaitEnabled() && broadcastId && yt.isConnected()) {
        const wait = await waitForYoutubeLive(broadcastId, {
          log: (m) => this.log(`slot ${slotDef.slot}: ${m}`),
        });
        if (!wait.live) {
          this.log(`slot ${slotDef.slot} YouTube not live yet (${wait.reason || wait.lifeCycleStatus}) — SEO deferred`);
        }
      }

      const goPublic = slotGoLivePrivacy(slotDef) === 'public';
      await this.manager._applySoloYoutubeSeo(q, broadcastId, slotDef.login, {
        setPublic: goPublic,
        membersOnlyChat: false,
      }, {
        streamerLock: true,
        fleetSlot: slotDef.slot,
        poolSlot: slotDef.localPool,
      });

      const { postFleetSupportChat } = require('../clipzworld_support');
      await postFleetSupportChat(broadcastId, (m) => this.log(`slot ${slotDef.slot}: ${m}`));

      st.phase = 'live';
      this._slotState.set(q, st);
      this.log(`slot ${slotDef.slot} @${slotDef.login} LIVE on ClipzWorld News${slotDef.testLane ? ' (private test lane)' : ''}`);
    } catch (e) {
      this.log(`slot ${slotDef.slot} start failed: ${e.message}`);
      st.phase = 'idle';
      this._slotState.set(q, st);
      this.manager.soloPublishers?.stopSeat(q);
      this.manager.feeders?.setQuadrant(q, null);
    }
    this._saveState();
  }

  async stopSlot(slotDef, reason = 'source_offline') {
    const q = slotDef.localIndex;
    const st = this._slotState.get(q);
    if (!st || st.phase === 'idle') return;

    this.log(`slot ${slotDef.slot} @${slotDef.login} ${reason} → stopping`);
    this.manager.soloPublishers?.stopSeat(q);
    this.manager.feeders?.setQuadrant(q, null);

    const bid = st.broadcastId || getBinding(slotDef.login)?.broadcastId
      || readSoloListingForPoolSlot(slotDef.localPool)?.broadcastId;
    if (bid && yt.isConnected()) {
      try {
        await yt.endLiveBroadcast(bid);
        this.log(`slot ${slotDef.slot} YouTube broadcast ended (${bid})`);
      } catch (e) {
        this.log(`slot ${slotDef.slot} endLiveBroadcast: ${e.message}`);
      }
    }

    this._slotState.set(q, { phase: 'idle', login: slotDef.login });
    this._saveState();
  }

  async tick() {
    if (this._tickInFlight) return;
    this._tickInFlight = true;
    try {
      for (const slotDef of this.slots) {
        if (isSlotPaused(slotDef)) {
          const st = this._slotState.get(slotDef.localIndex) || { phase: 'idle' };
          if (st.phase === 'live' || st.phase === 'starting') {
            await this.stopSlot(slotDef, 'kick_paused');
          }
          continue;
        }
        const live = await this.probeSlotLive(slotDef);
        const st = this._slotState.get(slotDef.localIndex) || { phase: 'idle' };
        const q = slotDef.localIndex;
        if (live && st.phase === 'idle') {
          await this.startSlot(slotDef);
        } else if (live && st.phase === 'starting') {
          await this.startSlot(slotDef);
        } else if (!live && (st.phase === 'live' || st.phase === 'starting')) {
          await this.stopSlot(slotDef);
        } else if (live && st.phase === 'live' && slotDef.platform === 'kick' && !this._feederIngestReady(q)) {
          await this._healKickIngest(slotDef);
        } else if (live && st.phase === 'live' && !this.manager.soloPublishers?.procs?.[q]) {
          this.log(`slot ${slotDef.slot} live but solo encoder down — nudging RTMP`);
          this.manager.soloPublishers?.start(q, slotDef.login);
        }
      }
    } finally {
      this._tickInFlight = false;
    }
  }

  status() {
    return {
      fleetId: this.fleetId,
      pollMs: POLL_MS,
      slots: this.slots.map((s) => {
        const st = this._slotState.get(s.localIndex) || { phase: 'idle' };
        const binding = getBinding(s.login);
        return {
          slot: s.slot,
          localPool: s.localPool,
          login: s.login,
          platform: s.platform,
          phase: st.phase,
          paused: isSlotPaused(s),
          pausedReason: s.pausedReason || null,
          broadcastId: st.broadcastId || binding?.broadcastId || null,
          watchUrl: binding?.watchUrl || null,
        };
      }),
    };
  }
}

module.exports = { SoloRosterOrchestrator, POLL_MS };
