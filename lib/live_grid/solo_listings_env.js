'use strict';

/**
 * CPD-1047 — Fixed YouTube solo listings (one per pool seat; up to 5 in solo_roster fleet).
 */

const { normalizeListingId } = require('./youtube_listing_env');
const { fleetPoolSize } = require('./fleet_pool');

function poolSize() {
  return fleetPoolSize();
}

function soloIndex(q) {
  const n = Number(q);
  const max = poolSize();
  if (!Number.isInteger(n) || n < 0 || n >= max) return null;
  return n + 1;
}

function readSoloListingForPoolSlot(slot) {
  const i = Number(slot);
  if (!Number.isInteger(i) || i < 1 || i > poolSize()) return null;
  const broadcastId = process.env[`LIVE_GRID_SOLO_${i}_BROADCAST_ID`] || null;
  const rtmpUrl = process.env[`LIVE_GRID_SOLO_${i}_RTMP_URL`] || null;
  if (!rtmpUrl) return null;
  const watchUrl = process.env[`LIVE_GRID_SOLO_${i}_WATCH_URL`]
    || (broadcastId ? `https://youtube.com/live/${broadcastId}` : null);
  return {
    poolSlot: i,
    quadrant: i,
    broadcastId,
    watchUrl,
    streamId: process.env[`LIVE_GRID_SOLO_${i}_STREAM_ID`] || null,
    rtmpUrl,
    label: process.env[`LIVE_GRID_SOLO_${i}_LABEL`] || `Screen ${i}`,
  };
}

function readSoloListingForQuadrant(q) {
  return readSoloListingForPoolSlot(soloIndex(q));
}

function readSoloListings() {
  const out = [];
  for (let q = 0; q < poolSize(); q++) {
    const row = readSoloListingForQuadrant(q);
    if (row) out.push(row);
  }
  return out;
}

function soloStreamsConfigured() {
  return readSoloListings().length > 0;
}

function soloStreamsEnabled() {
  return String(process.env.LIVE_GRID_SOLO_STREAMS ?? 'off').toLowerCase() === 'on';
}

/** Explicit opt-in — deploy/resume must never create solo listings by default. */
function soloCreateBroadcastsEnabled() {
  return String(process.env.LIVE_GRID_SOLO_CREATE_BROADCAST ?? 'off').toLowerCase() === 'on';
}

function soloRtmpForQuadrant(q) {
  return readSoloListingForQuadrant(q)?.rtmpUrl || null;
}

function persistSoloListing(q, opts = {}) {
  const { upsertEnvFile } = require('../env_persist');
  const path = require('path');
  const i = soloIndex(q);
  if (!i) throw new Error('quadrant must be 0-3');
  const envPath = opts.envPath || path.join(__dirname, '..', '..', '.env');
  const bid = opts.broadcastId != null ? normalizeListingId(opts.broadcastId) : null;
  if (!bid && opts.broadcastId !== '') {
    throw new Error('broadcastId required');
  }
  const updates = {};
  if (!bid) {
    updates[`LIVE_GRID_SOLO_${i}_BROADCAST_ID`] = '';
    updates[`LIVE_GRID_SOLO_${i}_WATCH_URL`] = '';
  } else {
    updates[`LIVE_GRID_SOLO_${i}_BROADCAST_ID`] = bid;
    updates[`LIVE_GRID_SOLO_${i}_WATCH_URL`] = opts.watchUrl || `https://youtube.com/live/${bid}`;
  }
  if (opts.rtmpUrl) updates[`LIVE_GRID_SOLO_${i}_RTMP_URL`] = opts.rtmpUrl;
  if (opts.streamId) updates[`LIVE_GRID_SOLO_${i}_STREAM_ID`] = opts.streamId;
  if (opts.label) updates[`LIVE_GRID_SOLO_${i}_LABEL`] = opts.label;
  upsertEnvFile(envPath, updates);
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;
  return readSoloListingForQuadrant(q);
}

function resolveSoloBroadcastIdFromMap(q, map, fallback = null) {
  if (!map) return fallback;
  const seat = q + 1;
  if (Array.isArray(map)) {
    return map[q] || map[seat - 1] || fallback;
  }
  return map[seat] || map[String(seat)] || map[q] || map[String(q)] || fallback;
}

module.exports = {
  poolSize,
  soloIndex,
  readSoloListingForPoolSlot,
  readSoloListingForQuadrant,
  readSoloListings,
  soloStreamsConfigured,
  soloStreamsEnabled,
  soloCreateBroadcastsEnabled,
  resolveSoloBroadcastIdFromMap,
  soloRtmpForQuadrant,
  persistSoloListing,
};
