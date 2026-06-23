'use strict';
/**
 * lib/creator_registry/index.js — Multi-platform creator registry (CPD-1027)
 *
 * Canonical store for streamers/creators across Twitch, Kick, and YouTube.
 * Populated from: Twitch follows, live grid streams, YouTube subscriptions,
 * Kick follows (when API available), manual URL add, streamerSources.json seed.
 */

const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, '..', '..', 'data', 'creator_registry.json');
const KIND_STREAMER = 'streamer';

function defaultRegistry() {
  return { version: 1, updatedAt: null, creators: {} };
}

function loadRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    if (!raw.creators || typeof raw.creators !== 'object') return defaultRegistry();
    return raw;
  } catch {
    return defaultRegistry();
  }
}

function saveRegistry(reg) {
  reg.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

function slugId(str) {
  return String(str || '').trim().toLowerCase().replace(/^@/, '').replace(/\s+/g, '');
}

function ensureCreator(reg, id, patch = {}) {
  const key = slugId(id);
  if (!key) return null;
  const now = new Date().toISOString();
  const existing = reg.creators[key] || {
    id: key,
    displayName: patch.displayName || key,
    kind: patch.kind || KIND_STREAMER,
    primaryPlatform: patch.primaryPlatform || null,
    platforms: {},
    sources: [],
    firstSeenAt: now,
    lastSeenAt: now,
    liveGridSeenCount: 0,
  };
  if (patch.displayName) existing.displayName = patch.displayName;
  if (patch.kind) existing.kind = patch.kind;
  if (patch.primaryPlatform) existing.primaryPlatform = patch.primaryPlatform;
  existing.lastSeenAt = now;
  reg.creators[key] = existing;
  return existing;
}

function addSource(creator, source) {
  if (!source) return;
  if (!Array.isArray(creator.sources)) creator.sources = [];
  if (!creator.sources.includes(source)) creator.sources.push(source);
}

function mergePlatform(creator, platform, data) {
  if (!platform || !data) return;
  creator.platforms = creator.platforms || {};
  creator.platforms[platform] = { ...(creator.platforms[platform] || {}), ...data };
  if (!creator.primaryPlatform) creator.primaryPlatform = platform;
}

/**
 * Upsert a creator from any sync source.
 * @returns {{ creator, created: boolean }}
 */
function upsertCreator({
  id,
  displayName,
  kind = KIND_STREAMER,
  platform,
  platformData = {},
  source,
  preservePrimaryPlatform = false,
} = {}) {
  const reg = loadRegistry();
  const key = slugId(id || platformData.login || platformData.slug || platformData.handle);
  if (!key) return { creator: null, created: false };

  const created = !reg.creators[key];
  const existing = reg.creators[key];
  const patch = { displayName, kind };
  if (!preservePrimaryPlatform || !existing?.primaryPlatform) {
    patch.primaryPlatform = platform;
  }
  const creator = ensureCreator(reg, key, patch);
  if (platform && Object.keys(platformData).length) mergePlatform(creator, platform, platformData);
  addSource(creator, source);
  saveRegistry(reg);
  return { creator, created };
}

function recordLiveGridStream(login, { reason, viewers } = {}) {
  if (!login) return null;
  const key = slugId(login);
  const reg = loadRegistry();
  const creator = ensureCreator(reg, key, {
    displayName: login,
    kind: KIND_STREAMER,
    primaryPlatform: 'twitch',
  });
  mergePlatform(creator, 'twitch', { login: key, displayName: creator.displayName || login });
  addSource(creator, 'live_grid');
  creator.liveGridSeenCount = (creator.liveGridSeenCount || 0) + 1;
  if (viewers != null) creator.lastLiveViewers = viewers;
  if (reason) creator.lastLiveGridReason = reason;
  saveRegistry(reg);
  return creator;
}

function recordLiveGridPoll({ live = {}, assignments = [] } = {}) {
  const touched = [];
  for (const [login, viewers] of Object.entries(live || {})) {
    touched.push(recordLiveGridStream(login, { reason: 'live_poll', viewers }));
  }
  for (const login of assignments || []) {
    if (login) touched.push(recordLiveGridStream(login, { reason: 'grid_assignment' }));
  }
  return touched.filter(Boolean);
}

function listCreators({ kind } = {}) {
  const reg = loadRegistry();
  let list = Object.values(reg.creators);
  if (kind) list = list.filter(c => c.kind === kind);
  return list.sort((a, b) => (b.lastSeenAt || '').localeCompare(a.lastSeenAt || ''));
}

/** Flat twitch-style login list for dashboard chips (streamers only). */
function getStreamerRosterLogins() {
  return listCreators({ kind: KIND_STREAMER })
    .map(c => {
      if (c.platforms?.twitch?.login) return c.platforms.twitch.login;
      if (c.platforms?.kick?.slug) return c.platforms.kick.slug;
      if (c.platforms?.youtube?.handle) return String(c.platforms.youtube.handle).replace(/^@/, '');
      return c.id;
    })
    .filter(Boolean);
}

function findByLogin(login) {
  const key = slugId(login);
  const reg = loadRegistry();
  if (reg.creators[key]) return reg.creators[key];
  for (const c of Object.values(reg.creators)) {
    const tw = c.platforms?.twitch?.login;
    const ki = c.platforms?.kick?.slug;
    const yt = c.platforms?.youtube?.handle;
    const ytId = c.platforms?.youtube?.channelId;
    if (tw && slugId(tw) === key) return c;
    if (ki && slugId(ki) === key) return c;
    if (yt && slugId(String(yt).replace(/^@/, '')) === key) return c;
    if (ytId && slugId(ytId) === key) return c;
    // Title slug id vs @handle alias (e.g. id chanelbrown, login chanelbrown_7)
    if (c.id && slugId(c.id) === key) return c;
    if (c.platforms?.youtube && key.startsWith(slugId(c.id)) && key.length > slugId(c.id).length) return c;
  }
  return null;
}

/** Seed from config/streamerSources.json if registry is empty. */
function seedFromStreamerSources() {
  const reg = loadRegistry();
  if (Object.keys(reg.creators).length > 0) return { seeded: 0 };
  let seeded = 0;
  try {
    const cfg = require('../../config/streamerSources.json');
    for (const [login, meta] of Object.entries(cfg.streamers || {})) {
      const platform = meta.platform || 'twitch';
      upsertCreator({
        id: login,
        displayName: meta.displayName || login,
        kind: KIND_STREAMER,
        platform,
        platformData: platform === 'youtube'
          ? { handle: meta.handle || login, login: slugId(meta.handle || login) }
          : platform === 'kick'
            ? { slug: login, login }
            : { login, displayName: meta.displayName || login },
        source: 'streamerSources_seed',
      });
      seeded++;
    }
  } catch (e) {
    console.warn('[creator_registry] seed failed:', e.message);
  }
  return { seeded };
}

/** Re-apply platform labels from config/streamerSources.json (seed metadata only). */
function syncPlatformsFromConfig() {
  let updated = 0;
  try {
    const cfg = require('../../config/streamerSources.json');
    const reg = loadRegistry();
    for (const [login, meta] of Object.entries(cfg.streamers || {})) {
      const platform = meta.platform || 'twitch';
      const platformData = platform === 'youtube'
        ? { handle: meta.handle || login, login: slugId(meta.handle || login), channelId: meta.channelId || null }
        : platform === 'kick'
          ? { slug: login, login }
          : { login, displayName: meta.displayName || login };
      const existing = reg.creators[login];
      const { created } = upsertCreator({
        id: login,
        displayName: meta.displayName || login,
        kind: KIND_STREAMER,
        platform,
        platformData,
        source: 'streamerSources_seed',
        preservePrimaryPlatform: !!existing?.primaryPlatform,
      });
      if (!created) updated++;
    }
  } catch (e) {
    console.warn('[creator_registry] syncPlatformsFromConfig failed:', e.message);
  }
  return { updated };
}

function resolveForPicker(login) {
  const key = slugId(login);
  const found = findByLogin(key);
  if (found) {
    const plat = found.primaryPlatform
      || (found.platforms?.twitch ? 'twitch' : null)
      || (found.platforms?.kick ? 'kick' : null)
      || (found.platforms?.youtube ? 'youtube' : null)
      || 'twitch';
    const pd = found.platforms?.[plat] || {};
    return {
      login: key,
      displayName: found.displayName || pd.displayName || key,
      platform: plat,
      handle: (pd.handle || pd.slug || pd.login || key).replace(/^@/, ''),
      channelId: pd.channelId || null,
      kind: found.kind || KIND_STREAMER,
    };
  }
  return null;
}

module.exports = {
  REGISTRY_PATH,
  KIND_STREAMER,
  loadRegistry,
  saveRegistry,
  upsertCreator,
  recordLiveGridStream,
  recordLiveGridPoll,
  listCreators,
  getStreamerRosterLogins,
  findByLogin,
  seedFromStreamerSources,
  syncPlatformsFromConfig,
  resolveForPicker,
  slugId,
};
