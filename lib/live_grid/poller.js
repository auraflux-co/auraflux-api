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
 *  - Fewer than 4 eligible streamers live → quadrant is null (slate).
 *
 * Bench tier (CPD-951): a second list of fallback streamers that only fill
 * quadrants the A-roster can't. Roster always outranks bench — an off-grid
 * live roster streamer preempts a bench incumbent IMMEDIATELY (no hysteresis);
 * bench challengers can only displace bench incumbents (with hysteresis).
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
 * @param {Object} opts { challengeRatio, challengeStreak, exclude:Set, bench:Set }
 * @returns {{ assignments: Array<string|null>, streaks: Object, swaps: Array }}
 */
function computeAssignments(current, live, streaks, opts = {}) {
  const challengeRatio = opts.challengeRatio ?? 1.2;
  const challengeStreak = opts.challengeStreak ?? 3;
  const exclude = opts.exclude || new Set();
  const bench = opts.bench || new Set();
  const operatorMode = !!opts.operatorMode;
  const tier = login => (bench.has(login) ? 1 : 0); // 0 = roster, 1 = bench

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

  if (operatorMode) {
    // Operator curates challengers — no outviewed/roster-priority reshuffles.
    // Empty slots (including offline drops) still fill from bench/roster.
    const ranked = Object.keys(live)
      .filter(l => eligible(l))
      .sort((a, b) => (tier(a) - tier(b)) || (live[b] - live[a]));
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
    return { assignments, streaks: {}, swaps };
  }

  // 2. Fill empty quadrants immediately with best available live streamers.
  //    Ranked roster-first, then bench — bench only fills what roster can't.
  const ranked = Object.keys(live)
    .filter(l => eligible(l))
    .sort((a, b) => (tier(a) - tier(b)) || (live[b] - live[a]));

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

  // 2.5 Roster always outranks bench — an off-grid live roster streamer
  //     preempts the weakest bench incumbent immediately (no hysteresis).
  for (const challenger of ranked) {
    if (tier(challenger) !== 0 || onGrid().has(challenger)) continue;
    const benchIncumbents = assignments.filter(l => l && tier(l) === 1);
    if (!benchIncumbents.length) break;
    const weakestBench = benchIncumbents.reduce((min, l) => (live[l] < live[min] ? l : min), benchIncumbents[0]);
    const q = assignments.indexOf(weakestBench);
    assignments[q] = challenger;
    swaps.push({ quadrant: q, out: weakestBench, in: challenger, reason: 'roster_priority' });
  }

  // 3. Challenger hysteresis — only the single strongest challenger can build
  //    a streak, and it displaces the lowest-viewer incumbent of its own tier
  //    or below (bench challengers can never unseat roster incumbents).
  const newStreaks = {};
  const challengers = ranked.filter(l => !onGrid().has(l));
  const incumbents = assignments.filter(Boolean);

  if (challengers.length && incumbents.length === GRID_SIZE) {
    const top = challengers[0];
    const displaceable = incumbents.filter(l => tier(l) >= tier(top));
    if (displaceable.length) {
      const weakest = displaceable.reduce((min, l) => (live[l] < live[min] ? l : min), displaceable[0]);
      if (live[top] >= live[weakest] * challengeRatio) {
        newStreaks[top] = (streaks[top] || 0) + 1;
        if (newStreaks[top] >= challengeStreak) {
          const q = assignments.indexOf(weakest);
          assignments[q] = top;
          swaps.push({ quadrant: q, out: weakest, in: top, reason: 'outviewed' });
          delete newStreaks[top];
        }
      }
    }
    // Any challenger that didn't qualify this poll has its streak reset
    // (by simply not being carried into newStreaks).
  }

  return { assignments, streaks: newStreaks, swaps };
}

/**
 * Live follows sync (CPD-955) — rebuild the bench from a fresh follows pull
 * while preserving dashboard +BENCH adds and removals.
 * bench = (follows − manualRemoves) ∪ manualAdds − roster
 */
function mergeBench(follows, manualAdds, manualRemoves, roster) {
  const rosterSet = new Set(roster);
  const next = new Set(follows.filter(l => !manualRemoves.has(l)));
  for (const l of manualAdds) next.add(l);
  for (const l of rosterSet) next.delete(l);
  return next;
}

class LiveGridPoller extends EventEmitter {
  constructor(options = {}) {
    super();
    this.roster = (options.roster || DEFAULT_ROSTER).map(l => l.toLowerCase());
    this.bench = new Set((options.bench ||
      (process.env.LIVE_GRID_BENCH || '').split(',').map(s => s.trim()).filter(Boolean)
    ).map(l => l.toLowerCase()));
    this.pollIntervalMs = options.pollIntervalMs || 60_000;
    this.challengeRatio = options.challengeRatio ?? 1.2;
    this.challengeStreak = options.challengeStreak ?? 3;
    this.exclude = new Set(options.exclude || []);
    // CPD-955: optional async () => string[]|null, called each poll to re-pull
    // the bench source (Twitch follows). Manual add/removes survive refreshes.
    this.refreshBench = options.refreshBench || null;
    this.benchManualAdds = new Set();
    this.benchManualRemoves = new Set();
    this.clientId = options.clientId || process.env.TWITCH_CLIENT_ID;
    this.token = (options.token || process.env.TWITCH_TOKEN || '').replace(/^oauth:/, '');

    this.assignments = [null, null, null, null];
    this.pinned = [null, null, null, null]; // CPD-1005 member !swap pins until offline
    this.benchFollows = [];
    this.allFollows = [];
    this.operatorMode = options.operatorMode ?? (String(process.env.LIVE_GRID_OPERATOR_MODE || 'off').toLowerCase() === 'on');
    this.streaks = {};
    this.lastLive = {};
    this._timer = null;
  }

  /** login → viewer_count for currently-live roster + bench streamers */
  async fetchLive() {
    const logins = [...new Set([...this.roster, ...this.bench])].slice(0, 100); // Helix cap
    if (!logins.length) return {};
    const resp = await axios.get('https://api.twitch.tv/helix/streams', {
      headers: { 'Client-ID': this.clientId, Authorization: `Bearer ${this.token}` },
      params: { user_login: logins, first: 100 },
      timeout: 10_000
    });
    const live = {};
    for (const s of resp.data?.data || []) live[s.user_login.toLowerCase()] = s.viewer_count;
    return live;
  }

  /** Helix probe for any Twitch login (member !swap guest picks). */
  async probeLoginLive(login) {
    const slug = String(login || '').trim().toLowerCase();
    if (!slug) return null;
    const resp = await axios.get('https://api.twitch.tv/helix/streams', {
      headers: { 'Client-ID': this.clientId, Authorization: `Bearer ${this.token}` },
      params: { user_login: [slug], first: 1 },
      timeout: 10_000
    });
    const s = resp.data?.data?.[0];
    if (!s) return null;
    return { login: s.user_login.toLowerCase(), viewers: s.viewer_count };
  }

  /**
   * Mutate roster/bench while live (CPD-951) — next poll picks changes up.
   *
   * `remove` (CPD-1001) demotes a grid occupant to the bench AND bars them
   * from re-seating until manually re-added (`add` or `benchAdd` clears the
   * bar). Without the bar, a high-viewer streamer would claw their quadrant
   * back within a few polls — useless when the point of removing them is
   * duplicate content (e.g. two roster streamers duo-streaming one game).
   * Roster/exclusion mutations are session-scoped: the next stream start
   * rebuilds from DEFAULT_ROSTER with a clean slate.
   */
  /** Pin a quadrant to a login (member !swap). Cleared when streamer goes offline. */
  pinQuadrant(q, login) {
    if (q < 0 || q > 3 || !login) return false;
    login = String(login).toLowerCase();
    this.pinned[q] = login;
    this.assignments[q] = login;
    return true;
  }

  clearPin(q) {
    if (q >= 0 && q < 4) this.pinned[q] = null;
  }

  updateRoster({ add = [], remove = [], benchAdd = [], benchRemove = [] } = {}) {
    const norm = arr => (Array.isArray(arr) ? arr : [arr]).map(l => String(l).trim().toLowerCase()).filter(Boolean);
    for (const l of norm(add)) {
      if (!this.roster.includes(l)) this.roster.push(l);
      this.bench.delete(l); // promotion: roster wins if listed in both
      this.exclude.delete(l);
    }
    for (const l of norm(remove)) {
      this.roster = this.roster.filter(r => r !== l);
      this.bench.add(l);            // back to the bench…
      this.benchManualAdds.add(l);  // …surviving follows re-syncs
      this.benchManualRemoves.delete(l);
      this.exclude.add(l);          // …but seated again only via manual re-add
    }
    for (const l of norm(benchAdd)) {
      if (!this.roster.includes(l)) this.bench.add(l);
      this.benchManualAdds.add(l);
      this.benchManualRemoves.delete(l);
      this.exclude.delete(l); // re-adding a removed streamer re-admits them
    }
    for (const l of norm(benchRemove)) {
      this.bench.delete(l);
      this.benchManualRemoves.add(l);
      this.benchManualAdds.delete(l);
    }
    return { roster: [...this.roster], bench: [...this.bench], excluded: [...this.exclude] };
  }

  async pollOnce() {
    // Live follows sync — fail-open: a failed pull keeps the current bench
    if (this.refreshBench) {
      try {
        const follows = await this.refreshBench();
        if (follows) this.bench = mergeBench(follows, this.benchManualAdds, this.benchManualRemoves, this.roster);
      } catch (_) {}
    }
    const live = await this.fetchLive();
    const { assignments, streaks, swaps } = computeAssignments(
      this.assignments, live, this.streaks,
      {
        challengeRatio: this.challengeRatio,
        challengeStreak: this.challengeStreak,
        exclude: this.exclude,
        bench: this.bench,
        operatorMode: this.operatorMode,
      }
    );
    // Member pins override ranking while the streamer stays live
    for (let q = 0; q < GRID_SIZE; q++) {
      const pin = this.pinned[q];
      if (!pin) continue;
      if (live[pin] != null && !this.exclude.has(pin)) assignments[q] = pin;
      else this.pinned[q] = null;
    }
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
      bench: [...this.bench],
      benchFollows: [...(this.benchFollows || [])],
      allFollows: [...(this.allFollows || [])],
      operatorMode: !!this.operatorMode,
      benchRemoved: [...this.benchManualRemoves],
      excluded: [...this.exclude],
      pinned: [...this.pinned],
    };
  }
}

module.exports = { LiveGridPoller, computeAssignments, mergeBench, DEFAULT_ROSTER, GRID_SIZE };
