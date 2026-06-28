'use strict';

const fs = require('fs');
const path = require('path');
const { mergeRanges } = require('./time_ranges');
const { youtubeVideoId } = require('./claims_csv');

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'post_live_vod_sessions.json');

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return { version: 1, sessions: {} };
  }
}

function writeStore(data) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

function normalizeSession(session) {
  const videoId = session.videoId || youtubeVideoId(session.url);
  if (!videoId) throw new Error('videoId or valid YouTube url required');

  const excludeRanges = mergeRanges((session.excludeRanges || []).map((r) => ({
    start: r.start,
    end: r.end,
    action: 'exclude',
    notes: r.notes || '',
  })));
  const muteRanges = mergeRanges((session.muteRanges || []).map((r) => ({
    start: r.start,
    end: r.end,
    action: 'mute',
    notes: r.notes || '',
  })));

  return {
    videoId,
    title: session.title || '',
    url: session.url || `https://www.youtube.com/watch?v=${videoId}`,
    streamer: session.streamer || null,
    durationSec: session.durationSec ?? null,
    published: session.published || null,
    category: session.category || null,
    views: session.views ?? null,
    excludeRanges,
    muteRanges,
    analyzeStatus: session.analyzeStatus || 'idle',
    analyzeError: session.analyzeError || null,
    analyzedAt: session.analyzedAt || null,
    candidates: Array.isArray(session.candidates) ? session.candidates : [],
    sceneCandidates: Array.isArray(session.sceneCandidates) ? session.sceneCandidates : [],
    sourceJobId: session.sourceJobId || null,
    contentType: session.contentType || null,
    showKey: session.showKey || null,
    showLabel: session.showLabel || null,
    repurposeMode: session.repurposeMode || null,
    sessionKind: session.sessionKind || 'live_archive',
    updatedAt: new Date().toISOString(),
    createdAt: session.createdAt || new Date().toISOString(),
  };
}

function upsertSession(partial) {
  const store = readStore();
  const prev = store.sessions[partial.videoId] || {};
  const merged = normalizeSession({ ...prev, ...partial, createdAt: prev.createdAt || new Date().toISOString() });
  store.sessions[merged.videoId] = merged;
  writeStore(store);
  return merged;
}

function importSessions(rows, { replaceClaims = false } = {}) {
  const store = readStore();
  const imported = [];

  for (const row of rows) {
    const videoId = row.videoId || youtubeVideoId(row.url);
    if (!videoId) continue;
    const prev = store.sessions[videoId] || {};
    const excludeRanges = replaceClaims ? row.excludeRanges : [...(prev.excludeRanges || []), ...(row.excludeRanges || [])];
    const muteRanges = replaceClaims ? row.muteRanges : [...(prev.muteRanges || []), ...(row.muteRanges || [])];
    const session = normalizeSession({
      ...prev,
      ...row,
      videoId,
      excludeRanges,
      muteRanges,
      createdAt: prev.createdAt || new Date().toISOString(),
    });
    store.sessions[videoId] = session;
    imported.push(session);
  }

  writeStore(store);
  return imported;
}

function listSessions() {
  const store = readStore();
  return Object.values(store.sessions).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function getSession(videoId) {
  const store = readStore();
  return store.sessions[videoId] || null;
}

function patchSession(videoId, patch) {
  const prev = getSession(videoId);
  if (!prev) return null;
  return upsertSession({ ...prev, ...patch, videoId });
}

module.exports = {
  STORE_PATH,
  readStore,
  upsertSession,
  importSessions,
  listSessions,
  getSession,
  patchSession,
  normalizeSession,
};
