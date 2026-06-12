/**
 * Live Grid — grid manager (CPD-946)
 *
 * Ties the layers together:
 *   poller (CPD-942) → feeders (CPD-943) → master compositor (CPD-944)
 *     → YouTube Live broadcast (CPD-945)
 *
 * - Poller assignments are applied to the feeders every poll (idempotent).
 * - Any quadrant change triggers a debounced planned master restart —
 *   established RTSP readers don't pick up a swapped publisher (see HOW page).
 * - Broadcast title refreshes on grid changes ("LIVE: a, b +2").
 * - caffeinate held while live so the Mac never sleeps mid-stream.
 */

const { spawn } = require('child_process');
const { LiveGridPoller, DEFAULT_ROSTER } = require('./poller');
const { getFollowedBench } = require('./follows');
const { QuadrantFeeders, generateSlate } = require('./feeders');
const { MasterCompositor } = require('./compositor');
const { ChatControl, tallyVotes } = require('./chat_control');
const { generateGridSeo, AUDIO_INSTRUCTIONS } = require('./seo');
const yt = require('../services/youtube_direct');

const SWAP_RESTART_DEBOUNCE_MS = 5_000;
const AUDIO_LEAD_RATIO = 1.2;        // auto mode: new leader must out-view audible by 20%
const CHAT_SWITCH_COOLDOWN_MS = 30_000;

function gridTitle(assignments) {
  const live = assignments.filter(Boolean);
  if (!live.length) return 'ClipzWorld Live Grid';
  const lead = live.slice(0, 2).join(', ');
  const more = live.length > 2 ? ` +${live.length - 2}` : '';
  return `🔴 LIVE: ${lead}${more} — ClipzWorld Grid`;
}

class LiveGridManager {
  constructor(opts = {}) {
    this.log = opts.log || ((m) => console.log(`[live-grid:mgr] ${m}`));
    this.opts = opts;
    this.poller = null;
    this.feeders = null;
    this.master = null;
    this.caffeinate = null;
    this.broadcast = null; // { broadcastId, watchUrl, streamId }
    this.startedAt = null;
    this.running = false;
    this._restartTimer = null;
    this._lastAssignments = [null, null, null, null];
    // Audio control (CPD-950): manual > chat > auto
    this.audioMode = 'auto';   // 'auto' | 'manual' | 'chat'
    this.audioQuad = 0;
    this.chat = null;
    this._lastChatSwitch = 0;
    this._votes = new Map(); // author → { quadrant, at } (CPD-954 voting)
  }

  /**
   * @param {Object} o { privacyStatus, title, description, roster, bench, exclude, output }
   *   privacyStatus defaults to LIVE_GRID_PRIVACY env or 'public' (CPD-977 —
   *   unlisted broadcasts earn no public watch hours; pass 'unlisted' for tests).
   *   `output` overrides YouTube entirely (e.g. a file path for rehearsal runs).
   */
  async start(o = {}) {
    if (this.running) throw new Error('live grid already running');
    this.running = true;
    this.startedAt = Date.now();

    await new Promise((res, rej) => generateSlate(e => e ? rej(e) : res()));

    // Bench default: Rob's Twitch follows (CPD-953) — fail-open to LIVE_GRID_BENCH env.
    // With no explicit bench, follows re-sync every poll (CPD-955): following a
    // channel on Twitch makes it bench-eligible within a minute, mid-stream.
    let bench = o.bench;
    let refreshBench = null;
    if (!bench) {
      refreshBench = () => getFollowedBench({ roster: o.roster || DEFAULT_ROSTER, exclude: o.exclude || [] });
      bench = await refreshBench();
      if (bench) this.log(`bench from Twitch follows: ${bench.length} channels (live sync on)`);
    }
    this.poller = new LiveGridPoller({ roster: o.roster, bench: bench || undefined, exclude: o.exclude, refreshBench });
    this.feeders = new QuadrantFeeders({ log: this.log });

    // First poll before going live so the grid opens populated, not 4 slates
    const { assignments } = await this.poller.pollOnce();
    this.feeders.applyAssignments(assignments);
    this._lastAssignments = [...assignments];

    let output = o.output;
    if (!output) {
      // GPT SEO title/description from the live lineup (fail-open to template)
      const seo = await generateGridSeo(this._lineup(assignments));
      if (seo) this.log(`SEO copy generated: "${seo.title}"`);
      const stream = await yt.createLiveStream({ title: 'ClipzWorld Live Grid ingest' });
      const broadcast = await yt.createLiveBroadcast({
        title: o.title || seo?.title || gridTitle(assignments),
        description: o.description || seo?.description ||
          `The biggest live moments from the ClipzWorld roster — four streams, one grid, all live.\n\n${AUDIO_INSTRUCTIONS}`,
        privacyStatus: o.privacyStatus || process.env.LIVE_GRID_PRIVACY || 'public',
        streamId: stream.streamId,
      });
      this.broadcast = { ...broadcast, streamId: stream.streamId };
      output = stream.rtmpUrl;
      this.log(`broadcast created: ${broadcast.watchUrl}`);
    }

    this.audioQuad = this._autoAudioQuad(assignments);
    this.master = new MasterCompositor({ output, logoPath: o.logoPath, log: this.log, audioQuad: this.audioQuad });
    // Give the feeders a moment to fill the MediaMTX paths
    await new Promise(r => setTimeout(r, 8000));
    this.master.start();

    this.poller.on('poll', ({ assignments }) => this._onAssignments(assignments));
    this.poller.on('error', (err) => this.log(`poller error (grid unchanged): ${err.message}`));
    this.poller.start();

    // Viewer chat control: !listen N / !audio N / !sound N
    if (this.broadcast) {
      try {
        this.chat = new ChatControl({
          broadcastId: this.broadcast.broadcastId,
          log: this.log,
          announceText: AUDIO_INSTRUCTIONS, // no pin API — recurring announcer instead
        });
        await this.chat.start();
        // Voting (CPD-954): one vote per author, majority rules, ties keep incumbent
        this.chat.on('command', ({ quadrant, author }) => {
          if (this.audioMode === 'manual') return; // operator override wins
          if (!this._lastAssignments[quadrant]) return; // slates not votable
          this._votes.set(author, { quadrant, at: Date.now() });
          if (Date.now() - this._lastChatSwitch < CHAT_SWITCH_COOLDOWN_MS) return;
          const result = tallyVotes(this._votes, this.audioQuad);
          if (result && this.setAudio(result.quadrant, 'chat')) {
            this._lastChatSwitch = Date.now();
            const login = this._lastAssignments[result.quadrant];
            this.log(`audio → quad${result.quadrant + 1} (chat vote: ${result.votes})`);
            this.chat.postMessage(`🔊 Now hearing ${(login || '').toUpperCase()} (screen ${result.quadrant + 1}) — ${result.votes} vote${result.votes === 1 ? '' : 's'}`)
              .catch(() => {});
          }
        });
      } catch (e) {
        this.log(`chat control unavailable: ${e.message}`);
      }
    }

    this.caffeinate = spawn('caffeinate', ['-dims'], { stdio: 'ignore' });
    this.log('live grid started');
    return this.status();
  }

  /** Live quadrant occupants as [{login, viewers}] for SEO/title generation. */
  _lineup(assignments) {
    const live = this.poller?.lastLive || {};
    return assignments.filter(Boolean).map(login => ({ login, viewers: live[login] || 0 }));
  }

  /** Quadrant index with the highest-viewer live streamer (-1 if all slates). */
  _autoAudioQuad(assignments) {
    const live = this.poller?.lastLive || {};
    let best = -1, bestViewers = -1;
    assignments.forEach((login, q) => {
      if (login && (live[login] || 0) > bestViewers) { best = q; bestViewers = live[login] || 0; }
    });
    return best >= 0 ? best : 0;
  }

  /**
   * Switch the on-air audio quadrant. Returns true if a switch happened.
   * source: 'manual' pins until released with setAudio('auto'); 'chat'/'auto' don't pin.
   */
  setAudio(quadrant, source = 'manual') {
    if (quadrant === 'auto') {
      this.audioMode = 'auto';
      this.log('audio control released to auto (follow the leader)');
      this._applyAudio(this._autoAudioQuad(this._lastAssignments), 'auto');
      return true;
    }
    const q = Number(quadrant);
    if (!Number.isInteger(q) || q < 0 || q > 3) return false;
    if (!this._lastAssignments[q]) { this.log(`audio → quad${q + 1} ignored (slate)`); return false; }
    if (source === 'manual') this.audioMode = 'manual';
    else if (this.audioMode !== 'manual') this.audioMode = source;
    return this._applyAudio(q, source);
  }

  _applyAudio(q, source) {
    if (q === this.audioQuad) return false;
    this.audioQuad = q;
    if (this.master) {
      // Seamless switch via runtime filter commands (CPD-960);
      // restart only if the master process isn't accepting commands
      if (!this.master.setAudioQuad(q)) this.master.restart();
    }
    this.log(`on-air audio → quad${q + 1} (${this._lastAssignments[q] || 'slate'}, ${source})`);
    return true;
  }

  _onAssignments(assignments) {
    if (!this.running) return;
    const changed = assignments.some((a, i) => a !== this._lastAssignments[i]);
    this.feeders.applyAssignments(assignments);
    this._lastAssignments = [...assignments];

    // Auto audio: follow the leader (with hysteresis), or bail out of a dead quadrant
    const live = this.poller?.lastLive || {};
    const audibleLogin = assignments[this.audioQuad];
    if (!audibleLogin && this.audioMode !== 'manual') {
      // audible quadrant went slate — move immediately, any mode except pinned manual
      const next = this._autoAudioQuad(assignments);
      if (assignments[next]) { this.audioMode = 'auto'; this._applyAudio(next, 'auto'); }
    } else if (this.audioMode === 'auto') {
      const leader = this._autoAudioQuad(assignments);
      const leaderLogin = assignments[leader];
      if (leaderLogin && leader !== this.audioQuad &&
          (live[leaderLogin] || 0) >= (live[audibleLogin] || 0) * AUDIO_LEAD_RATIO) {
        this._applyAudio(leader, 'auto');
      }
    }

    if (!changed) return;
    clearTimeout(this._restartTimer);
    this._restartTimer = setTimeout(() => {
      if (!this.running || !this.master) return;
      // Quadrant swaps always need a master restart (RTSP readers don't pick
      // up a new publisher); audio switches alone no longer do (CPD-960)
      this.master.restart();
      if (this.broadcast) {
        generateGridSeo(this._lineup(assignments))
          .then(seo => yt.updateBroadcastMeta(this.broadcast.broadcastId, {
            title: seo?.title || gridTitle(assignments),
            description: seo?.description,
          }))
          .catch(e => this.log(`title update failed: ${e.message}`));
      }
    }, SWAP_RESTART_DEBOUNCE_MS);
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this._restartTimer);
    this.poller?.stop();
    this.chat?.stop();
    this.master?.stop();
    this.feeders?.stopAll();
    if (this.caffeinate) { try { this.caffeinate.kill(); } catch (_) {} }
    if (this.broadcast) {
      try { await yt.endLiveBroadcast(this.broadcast.broadcastId); this.log('broadcast ended'); }
      catch (e) { this.log(`endLiveBroadcast failed: ${e.response?.data?.error?.message || e.message}`); }
    }
    this.log('live grid stopped');
  }

  status() {
    return {
      running: this.running,
      uptimeSec: this.startedAt && this.running ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      broadcast: this.broadcast ? { id: this.broadcast.broadcastId, watchUrl: this.broadcast.watchUrl } : null,
      quadrants: this.feeders ? this.feeders.status() : [],
      audio: {
        quadrant: this.audioQuad + 1,
        login: this._lastAssignments[this.audioQuad] || null,
        mode: this.audioMode,
        chatControl: !!this.chat?.running,
      },
      poller: this.poller ? this.poller.status() : null,
      master: this.master ? this.master.status() : null,
    };
  }
}

module.exports = { LiveGridManager, gridTitle };
