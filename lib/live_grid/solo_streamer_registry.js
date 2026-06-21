'use strict';

/**
 * CPD-1064 — Streamer-locked solo YouTube listings.
 * Each on-grid streamer keeps one watch URL for the session; quadrant swaps repoint
 * the video encoder only — audience bookmarks stay valid until the streamer leaves.
 *
 * Physical stream keys remain LIVE_GRID_SOLO_1..4 (pool slots); bindings map login → slot.
 */

const fs = require('fs');
const path = require('path');
const { readSoloListingForQuadrant } = require('./solo_listings_env');
const { normalizeSoloLogin } = require('./solo_seo');

function streamerLockEnabled() {
  if (String(process.env.LIVE_GRID_SOLO_STREAMS ?? 'off').toLowerCase() !== 'on') return false;
  return String(process.env.LIVE_GRID_SOLO_STREAMER_LOCK ?? 'on').toLowerCase() !== 'off';
}

function registryPath() {
  const dir = process.env.LIVE_GRID_RESUME_DIR
    || (process.env.RENDER ? '/app/tmp' : path.join(__dirname, '..', '..', 'data'));
  return path.join(dir, 'solo_streamer_registry.json');
}

function poolSlotListing(slot) {
  const n = Number(slot);
  if (!Number.isInteger(n) || n < 1 || n > 4) return null;
  return readSoloListingForQuadrant(n - 1);
}

function listingFromSlot(slot) {
  const row = poolSlotListing(slot);
  if (!row?.rtmpUrl) return null;
  return {
    slot,
    broadcastId: row.broadcastId || null,
    watchUrl: row.watchUrl || (row.broadcastId ? `https://youtube.com/live/${row.broadcastId}` : null),
    rtmpUrl: row.rtmpUrl,
    streamId: row.streamId || null,
    label: row.label || `Screen ${slot}`,
  };
}

let _cache = null;

function loadRegistry(force = false) {
  if (_cache && !force) return _cache;
  const empty = { version: 1, bindings: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(), 'utf8'));
    _cache = { version: 1, bindings: raw.bindings || {} };
  } catch (_) {
    _cache = empty;
  }
  return _cache;
}

function saveRegistry(reg = loadRegistry()) {
  const p = registryPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: reg.version, updatedAt: new Date().toISOString(), bindings: reg.bindings }, null, 2));
  _cache = reg;
}

function getBinding(login) {
  const lg = normalizeSoloLogin(login);
  if (!lg) return null;
  return loadRegistry().bindings[lg] || null;
}

function activeBindings() {
  return { ...loadRegistry().bindings };
}

function rtmpForLogin(login) {
  return getBinding(login)?.rtmpUrl || null;
}

function watchUrlForLogin(login) {
  return getBinding(login)?.watchUrl || null;
}

function broadcastIdForLogin(login) {
  return getBinding(login)?.broadcastId || null;
}

function resolveRtmpForQuadrant(q, login) {
  if (streamerLockEnabled()) {
    const fromLogin = rtmpForLogin(login);
    if (fromLogin) return fromLogin;
  }
  return require('./solo_listings_env').soloRtmpForQuadrant(q);
}

function hasRtmpTarget(q, login) {
  return !!resolveRtmpForQuadrant(q, login);
}

function applyLoginSlotMap(slotMap = {}, assignments = []) {
  if (!streamerLockEnabled()) throw new Error('LIVE_GRID_SOLO_STREAMER_LOCK=off');
  const reg = loadRegistry(true);
  const slotsUsed = new Map();
  const updates = {};

  for (const [rawLogin, rawSlot] of Object.entries(slotMap)) {
    const login = normalizeSoloLogin(rawLogin);
    const slot = Number(rawSlot);
    if (!login) throw new Error(`invalid login: ${rawLogin}`);
    if (!Number.isInteger(slot) || slot < 1 || slot > 4) {
      throw new Error(`invalid pool slot for ${login}: ${rawSlot}`);
    }
    if (slotsUsed.has(slot)) {
      throw new Error(`pool slot ${slot} assigned twice (${slotsUsed.get(slot)} and ${login})`);
    }
    const listing = listingFromSlot(slot);
    if (!listing?.rtmpUrl) throw new Error(`pool slot ${slot} not configured (LIVE_GRID_SOLO_${slot}_RTMP_URL)`);
    slotsUsed.set(slot, login);
    updates[login] = {
      login,
      slot,
      pinned: true,
      assignedAt: new Date().toISOString(),
      ...listing,
    };
  }

  for (const lg of Object.keys(reg.bindings)) {
    if (updates[lg]) continue;
    const taken = [...slotsUsed.values()].includes(lg);
    if (taken) delete reg.bindings[lg];
  }

  for (const [login, binding] of Object.entries(updates)) {
    reg.bindings[login] = binding;
  }

  for (let q = 0; q < 4; q++) {
    const lg = normalizeSoloLogin(assignments[q]);
    if (lg && reg.bindings[lg]) reg.bindings[lg].currentQuadrant = q + 1;
  }

  saveRegistry(reg);
  return { ok: true, bindings: { ...reg.bindings } };
}

/** Update pool slot broadcastId/watchUrl in runtime env (ingest key unchanged). */
function updatePoolSlotListing(slot, opts = {}) {
  const { persistSoloListing } = require('./solo_listings_env');
  const n = Number(slot);
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error('slot must be 1-4');
  if (!opts.broadcastId) throw new Error('broadcastId required');
  return persistSoloListing(n - 1, {
    broadcastId: opts.broadcastId,
    watchUrl: opts.watchUrl,
    rtmpUrl: opts.rtmpUrl,
    streamId: opts.streamId,
    label: opts.label,
  });
}

/**
 * Keep login → pool slot bindings aligned with current grid assignments.
 * Streamers who leave the grid release their slot; swaps only update currentQuadrant.
 * Pinned bindings keep their slot unless applyLoginSlotMap overrides.
 * @param {(string|null)[]} assignments — logins per quadrant Q1–Q4
 */
function syncBindingsForAssignments(assignments = []) {
  if (!streamerLockEnabled()) return { synced: false, reason: 'streamer_lock_off' };

  const reg = loadRegistry(true);
  const active = assignments.map((l) => normalizeSoloLogin(l)).filter(Boolean);
  const activeSet = new Set(active);

  for (const lg of Object.keys(reg.bindings)) {
    if (!activeSet.has(lg)) delete reg.bindings[lg];
  }

  const usedSlots = new Set(
    Object.values(reg.bindings).filter((b) => b.pinned).map((b) => b.slot)
  );
  for (const b of Object.values(reg.bindings)) {
    if (!b.pinned) usedSlots.add(b.slot);
  }

  for (const lg of active) {
    if (reg.bindings[lg]) continue;
    const freeSlot = [1, 2, 3, 4].find((s) => !usedSlots.has(s) && poolSlotListing(s)?.rtmpUrl);
    if (!freeSlot) continue;
    const listing = listingFromSlot(freeSlot);
    if (!listing) continue;
    reg.bindings[lg] = {
      login: lg,
      currentQuadrant: null,
      assignedAt: new Date().toISOString(),
      ...listing,
    };
    usedSlots.add(freeSlot);
  }

  for (let q = 0; q < 4; q++) {
    const lg = normalizeSoloLogin(assignments[q]);
    if (lg && reg.bindings[lg]) reg.bindings[lg].currentQuadrant = q + 1;
  }

  saveRegistry(reg);
  return {
    synced: true,
    active: active.length,
    bindings: Object.keys(reg.bindings).length,
  };
}

/** Seed registry from quadrant env + assignments (first run / migration). */
function seedFromQuadrantEnv(assignments = []) {
  if (!streamerLockEnabled()) return { seeded: false };
  const reg = loadRegistry(true);
  if (Object.keys(reg.bindings).length) return { seeded: false, reason: 'already_populated' };

  for (let q = 0; q < 4; q++) {
    const lg = normalizeSoloLogin(assignments[q]);
    if (!lg || reg.bindings[lg]) continue;
    const listing = listingFromSlot(q + 1);
    if (!listing) continue;
    reg.bindings[lg] = {
      login: lg,
      currentQuadrant: q + 1,
      assignedAt: new Date().toISOString(),
      seededFromQuadrant: q + 1,
      ...listing,
    };
  }
  if (Object.keys(reg.bindings).length) saveRegistry(reg);
  return { seeded: true, count: Object.keys(reg.bindings).length };
}

function statusRows(assignments = []) {
  if (!streamerLockEnabled()) return null;
  syncBindingsForAssignments(assignments);
  return [0, 1, 2, 3].map((q) => {
    const login = normalizeSoloLogin(assignments[q]) || null;
    const binding = login ? getBinding(login) : null;
    return {
      quadrant: q + 1,
      login,
      watchUrl: binding?.watchUrl || null,
      broadcastId: binding?.broadcastId || null,
      poolSlot: binding?.slot || null,
      streamerLocked: !!binding,
    };
  });
}

module.exports = {
  streamerLockEnabled,
  registryPath,
  loadRegistry,
  saveRegistry,
  getBinding,
  activeBindings,
  rtmpForLogin,
  watchUrlForLogin,
  broadcastIdForLogin,
  resolveRtmpForQuadrant,
  hasRtmpTarget,
  syncBindingsForAssignments,
  applyLoginSlotMap,
  updatePoolSlotListing,
  seedFromQuadrantEnv,
  statusRows,
  listingFromSlot,
};
