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
    } catch (_) {}
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
    if (slotDef.platform === 'kick') {
      return kickChannelLive(slotDef.kickSlug || slotDef.login);
    }
    return twitchChannelLive(slotDef.login);
  }

  _seatFeeder(slotDef) {
    const q = slotDef.localIndex;
    if (slotDef.platform === 'kick') {
      this.manager.feeders.setQuadrantKick(q, slotDef.kickSlug || slotDef.login, {
        label: slotDef.login,
      });
    } else {
      this.manager.feeders.setQuadrant(q, slotDef.login);
    }
  }

  async _waitRtsp(q) {
    const url = quadUrl(q);
    const deadline = Date.now() + RTSP_READY_MS;
    while (Date.now() < deadline) {
      if (await rtspHasVideo(url, 4000)) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return rtspHasVideo(url, 4000);
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
        privacyStatus: 'unlisted',
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
    const q = slotDef.localIndex;
    const st = this._slotState.get(q) || { phase: 'idle', login: slotDef.login };
    if (st.phase === 'starting' || st.phase === 'live') return;
    st.phase = 'starting';
    st.login = slotDef.login;
    this._slotState.set(q, st);
    this.log(`slot ${slotDef.slot} @${slotDef.login} source live → starting`);

    try {
      this._seatFeeder(slotDef);
      const rtspOk = await this._waitRtsp(q);
      if (!rtspOk) {
        this.log(`slot ${slotDef.slot} RTSP not ready — will retry next poll`);
        st.phase = 'idle';
        this._slotState.set(q, st);
        return;
      }

      const broadcastId = await this._ensureBroadcast(slotDef);
      st.broadcastId = broadcastId;

      this.manager.soloPublishers.start(q, slotDef.login);

      if (goLiveWaitEnabled() && broadcastId && yt.isConnected()) {
        const wait = await waitForYoutubeLive(broadcastId, {
          log: (m) => this.log(`slot ${slotDef.slot}: ${m}`),
        });
        if (!wait.live) {
          this.log(`slot ${slotDef.slot} YouTube not live yet (${wait.reason || wait.lifeCycleStatus}) — SEO deferred`);
        }
      }

      await this.manager._applySoloYoutubeSeo(q, broadcastId, slotDef.login, {
        setPublic: true,
        membersOnlyChat: false,
      }, {
        streamerLock: true,
        fleetSlot: slotDef.slot,
        poolSlot: slotDef.localPool,
      });

      st.phase = 'live';
      this._slotState.set(q, st);
      this.log(`slot ${slotDef.slot} @${slotDef.login} LIVE on ClipzWorld News`);
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
        const live = await this.probeSlotLive(slotDef);
        const st = this._slotState.get(slotDef.localIndex) || { phase: 'idle' };
        if (live && st.phase === 'idle') {
          await this.startSlot(slotDef);
        } else if (!live && (st.phase === 'live' || st.phase === 'starting')) {
          await this.stopSlot(slotDef);
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
          broadcastId: st.broadcastId || binding?.broadcastId || null,
          watchUrl: binding?.watchUrl || null,
        };
      }),
    };
  }
}

module.exports = { SoloRosterOrchestrator, POLL_MS };
