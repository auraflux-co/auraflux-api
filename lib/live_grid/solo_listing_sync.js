'use strict';

/**
 * Twitch grid → YouTube solo listing sync (CPD-1047).
 * Reads who is on each quadrant from the live sidecar (Twitch-sourced feeders),
 * resolves the matching YouTube broadcast by ingest stream key, pushes discoverability SEO.
 *
 * Modes:
 * - discoverable (default) — title, description + hashtags, tags, playlist, public
 * - lite — title + description only (emergency / low quota)
 */

const { buildSoloLiveSeo, normalizeSoloLogin } = require('./solo_seo');
const { discoverBroadcastIds, pickBestForStream } = require('./broadcast_discover');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Build seat rows from sidecar /live-grid/status (Twitch login + solo watch URL). */
function seatsFromSidecarStatus(status = {}) {
  const byQuad = {};
  for (const q of status.quadrants || []) {
    if (q?.quadrant) byQuad[q.quadrant] = q;
  }
  const soloSeats = status.soloStreams?.seats || [];
  const mainWatchUrl = status.broadcast?.watchUrl || '';
  const gridLogins = [1, 2, 3, 4].map((n) => byQuad[n]?.login || soloSeats.find((s) => s.quadrant === n)?.login || null);

  return soloSeats.map((seat) => {
    const q = seat.quadrant;
    const quad = byQuad[q] || {};
    const login = normalizeSoloLogin(quad.login || quad.channelSlug || seat.login);
    return {
      quadrant: q,
      login,
      broadcastId: seat.broadcastId || null,
      watchUrl: seat.watchUrl || null,
      label: seat.label || `Screen ${q}`,
      twitchFeedUrl: quad.feedUrl || (login ? `https://www.twitch.tv/${login}` : null),
      configured: !!seat.configured,
    };
  }).filter((s) => s.configured !== false);
}

function resolveBroadcastIdForSeat(seat, idMap = {}) {
  const fromMap = idMap[seat.quadrant] || idMap[String(seat.quadrant)];
  if (fromMap) return fromMap;
  if (seat.broadcastId) return seat.broadcastId;
  return null;
}

async function applySeatSeo(yt, broadcastId, seo, seat, mode, log) {
  const seatLog = (m) => log(`Q${seat.quadrant}: ${m}`);
  if (mode === 'lite') {
    return yt.updateBroadcastListingLite(broadcastId, seo, seatLog);
  }
  const fn = yt.applyLiveBroadcastSeoDiscoverable || yt.applyLiveBroadcastSeo;
  return fn.call(yt, broadcastId, seo, {
    log: seatLog,
    setPublic: true,
    membersOnlyChat: false,
  });
}

/**
 * Sync solo YouTube listings from grid state.
 * @param {object} opts
 * @param {'discoverable'|'lite'} [opts.mode='discoverable']
 * @param {number} [opts.seatDelayMs=1500] — pause between seats to spread quota
 */
async function syncSoloListingsFromGrid(opts = {}) {
  const log = opts.log || (() => {});
  const yt = opts.yt;
  const mode = opts.mode === 'lite' ? 'lite' : 'discoverable';
  const seatDelayMs = opts.seatDelayMs ?? parseInt(process.env.LIVE_GRID_SOLO_SYNC_DELAY_MS || '1500', 10);

  if (!yt?.isConnected?.()) {
    return { ok: false, reason: 'YouTube OAuth not connected' };
  }

  if (mode === 'discoverable' && opts.sanitizeChannel !== false && yt.sanitizeChannelKeywords) {
    try {
      await yt.sanitizeChannelKeywords((m) => log(`channel: ${m}`));
    } catch (e) {
      log(`channel keyword sanitize skipped: ${e.response?.data?.error?.message || e.message}`);
    }
  }

  const status = opts.status || {};
  const mainWatchUrl = status.broadcast?.watchUrl || '';
  const seats = seatsFromSidecarStatus(status);
  const idMap = opts.discovered?.soloBroadcastIds || {};
  const byQuad = {};
  for (const q of status.quadrants || []) {
    if (q?.quadrant) byQuad[q.quadrant] = q;
  }
  const gridLogins = [1, 2, 3, 4].map((n) => {
    const q = byQuad[n];
    return normalizeSoloLogin(q?.login || q?.channelSlug) || null;
  });

  const want = opts.quadrants?.length
    ? new Set(opts.quadrants.map((n) => Number(n)))
    : null;

  const results = [];
  let seatIndex = 0;
  for (const seat of seats) {
    if (want && !want.has(seat.quadrant)) continue;
    if (seatIndex++ > 0 && seatDelayMs > 0) await sleep(seatDelayMs);

    const broadcastId = resolveBroadcastIdForSeat(seat, idMap);
    if (!broadcastId) {
      results.push({ quadrant: seat.quadrant, login: seat.login, ok: false, error: 'no broadcastId (discover failed or seat not pinned)' });
      continue;
    }
    const seo = buildSoloLiveSeo({
      login: seat.login || '',
      quadrant: seat.quadrant - 1,
      mainWatchUrl,
      gridLogins,
    });

    if (opts.dryRun) {
      results.push({
        quadrant: seat.quadrant,
        broadcastId,
        login: seat.login,
        ok: true,
        dryRun: true,
        mode,
        title: seo.title,
        tagCount: seo.tags?.length || 0,
        watchUrl: seat.watchUrl,
      });
      continue;
    }

    try {
      const out = await applySeatSeo(yt, broadcastId, seo, seat, mode, log);
      results.push({
        quadrant: seat.quadrant,
        broadcastId,
        login: seat.login,
        watchUrl: seat.watchUrl || `https://youtube.com/live/${broadcastId}`,
        mode,
        ok: !!out.ok,
        title: seo.title,
        tags: out.tags,
        playlist: out.playlist,
        public: out.public,
      });
    } catch (e) {
      results.push({
        quadrant: seat.quadrant,
        broadcastId,
        login: seat.login,
        ok: false,
        error: e.response?.data?.error?.message || e.message,
      });
    }
  }

  return {
    ok: results.some((r) => r.ok),
    mode,
    mainWatchUrl,
    results,
  };
}

module.exports = {
  seatsFromSidecarStatus,
  resolveBroadcastIdForSeat,
  syncSoloListingsFromGrid,
  discoverBroadcastIds,
  pickBestForStream,
};
