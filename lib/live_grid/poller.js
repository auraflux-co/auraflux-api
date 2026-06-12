/**
 * Live Grid — Helix roster poller + top-4 quadrant ranking engine (CPD-942)
 *
 * Polls Twitch Helix for live status + viewer counts across the roster and
 * decides which 4 streamers hold the 2x2 grid quadrants.
 *
 * Ranking rules (hysteresis — see Confluence "HOW — C0 Live Grid", page 30932993):
 *  - Incumbent goes offline (or is excluded) → replaced immediately by the
 *    highest-ranked live streamer not already on the grid.
 *  - A challenger only displaces a live incumbent if its viewer count exceeds
 *    the LOWEST incumbent's by `challengeRatio` (default 1.2x) for
 *    `challengeStreak` consecutive polls (default 3 → 3 minutes at 60s polls).
 *  - Viewer-count jiggle below the ratio never reshuffles the grid.
 *  - Fewer than 4 roster streamers live → quadrant is null (slate).
 *
 * Emits:
 *  - 'poll'  { live, assignments }            — every successful poll
 *  - 'swap'  { quadrant, out, in, reason }    — every quadrant change
 *  - 'error' (err)                            — poll failure (grid unchanged)
 */

const axios = require('axios');
const { EventEmitter } = require('events');

// Mirrors TWITCH_STREAMERS in cwn_production.html — the C0 long-form roster.
const DEFAULT_ROSTER = [
  'jasontheween', 'adapt', 'marlon', 'extraemily', 'stableronaldo', 'maya',
  'cinna', 'yonnajay', 'jaycinco', 'lacy', 'hasanabi', 'yourragegaming'
];

const GRID_SIZE = 4;

/**
 * Pure quadrant-assignment step — exported for unit tests.
 *
 * @param {Array<string|null>} current  — current quadrant logins (length 4)
 * @param {Object<string,number>} live  — login → viewer_count for LIVE streamers only
 * @param {Object<string,number>} streaks — challenger login → consecutive qualifying polls
 * @param {Object} opts { challengeRatio, challengeStreak, exclude:Set }
 * @returns {{ assignments: Array<string|null>, streaks: Object, swaps: Array }}
 */
function computeAssignments(current, live, streaks, opts = {}) {
  const challengeRatio = opts.challengeRatio ?? 1.2;
  const challengeStreak = opts.challengeStreak ?? 3;
  const exclude = opts.exclude || new Set();

  const assignments = [...(current || [])];
  while (assignments.length < GRID_SIZE) assignments.push(null);
  const swaps = [];

  const eligible = login => live[login] != null && !exclude.has(login);

  // 1. Drop incumbents that went offline or got excluded
  for (let q = 0; q < GRID_SIZE; q++) {
    const inc = assignments[q];
    if (inc && !eligible(inc)) {
      assignments[q] = null;
      swaps.push({ quadrant: q, out: inc, in: null, reason: exclude.has(inc) ? 'excluded' : 'offline' });
    }
  }

  const onGrid = () => new Set(assignments.filter(Boolean));

  // 2. Fill empty quadrants immediately with best available live streamers
  const ranked = Object.keys(live)
    .filter(l => eligible(l))
    .sort((a, b) => live[b] - live[a]);

  for (let q = 0; q < GRID_SIZE; q++) {
    if (assignments[q]) continue;
    const next = ranked.find(l => !onGrid().has(l));
    if (next) {
      const prior = swaps.find(s => s.quadrant === q && s.in === null);
      assignments[q] = next;
      if (prior) prior.in = next;
      else swaps.push({ quadrant: q, out: null, in: next, reason: 'fill' });
    }
  }

  // 3. Challenger hysteresis — only the single strongest challenger can build
  //    a streak, and it displaces the lowest-viewer incumbent.
  const newStreaks = {};
  const challengers = ranked.filter(l => !onGrid().has(l));
  const incumbents = assignments.filter(Boolean);

  if (challengers.length && incumbents.length === GRID_SIZE) {
    const weakest = incumbents.reduce((min, l) => (live[l] < live[min] ? l : min), incumbents[0]);
    const top = challengers[0];

    if (live[top] >= live[weakest] * challengeRatio) {
      newStreaks[top] = (streaks[top] || 0) + 1;
      if (newStreaks[top] >= challengeStreak) {
        const q = assignments.indexOf(weakest);
        assignments[q] = top;
        swaps.push({ quadrant: q, out: weakest, in: top, reason: 'outviewed' });
        delete newStreaks[top];
      }
    }
    // Any challenger that didn't qualify this poll has its streak reset
    // (by simply not being carried into newStreaks).
  }

  return { assignments, streaks: newStreaks, swaps };
}

class LiveGridPoller extends EventEmitter {
  constructor(options = {}) {
    super();
    this.roster = options.roster || DEFAULT_ROSTER;
    this.pollIntervalMs = options.pollIntervalMs || 60_000;
    this.challengeRatio = options.challengeRatio ?? 1.2;
    this.challengeStreak = options.challengeStreak ?? 3;
    this.exclude = new Set(options.exclude || []);
    this.clientId = options.clientId || process.env.TWITCH_CLIENT_ID;
    this.token = (options.token || process.env.TWITCH_TOKEN || '').replace(/^oauth:/, '');

    this.assignments = [null, null, null, null];
    this.streaks = {};
    this.lastLive = {};
    this._timer = null;
  }

  /** login → viewer_count for currently-live roster streamers */
  async fetchLive() {
    const resp = await axios.get('https://api.twitch.tv/helix/streams', {
      headers: { 'Client-ID': this.clientId, Authorization: `Bearer ${this.token}` },
      params: { user_login: this.roster, first: 20 },
      timeout: 10_000
    });
    const live = {};
    for (const s of resp.data?.data || []) live[s.user_login.toLowerCase()] = s.viewer_count;
    return live;
  }

  async pollOnce() {
    const live = await this.fetchLive();
    const { assignments, streaks, swaps } = computeAssignments(
      this.assignments, live, this.streaks,
      { challengeRatio: this.challengeRatio, challengeStreak: this.challengeStreak, exclude: this.exclude }
    );
    this.assignments = assignments;
    this.streaks = streaks;
    this.lastLive = live;
    for (const swap of swaps) this.emit('swap', swap);
    this.emit('poll', { live, assignments: [...assignments] });
    return { live, assignments, swaps };
  }

  start() {
    if (this._timer) return;
    const tick = () => this.pollOnce().catch(err => this.emit('error', err));
    tick();
    this._timer = setInterval(tick, this.pollIntervalMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  status() {
    return {
      assignments: [...this.assignments],
      live: { ...this.lastLive },
      streaks: { ...this.streaks },
      roster: [...this.roster],
      excluded: [...this.exclude]
    };
  }
}

module.exports = { LiveGridPoller, computeAssignments, DEFAULT_ROSTER, GRID_SIZE };
