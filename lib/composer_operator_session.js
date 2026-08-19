'use strict';
/**
 * CPD-1316 — Composer session on disk so the operator dashboard can restore
 * looks saved from another browser (agent session).
 */

const fs = require('fs');
const path = require('path');

const SESSION_PATH = path.join(__dirname, '..', 'data', 'composer_operator_session.json');
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function sessionPath() {
  return SESSION_PATH;
}

function readOperatorComposerSession() {
  try {
    if (!fs.existsSync(SESSION_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
    if (!data || data.version !== 1) return null;
    if (data.savedAt && (Date.now() - Number(data.savedAt)) > MAX_AGE_MS) return null;
    const hasContent = (data.streamers && data.streamers.length)
      || (data.redditThreads && data.redditThreads.length)
      || (data.wireStories && data.wireStories.length)
      || data.vodSegment;
    if (!hasContent) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function clipUrlKey(clip) {
  return String((clip && (clip.url || clip.pageUrl)) || '').trim();
}

function collectOpeningLooks(session) {
  const map = new Map();
  const streamers = (session && session.streamers) || [];
  streamers.forEach((s) => {
    (s.clips || []).forEach((c) => {
      const k = clipUrlKey(c);
      if (k && c.openingLayout && c.openingLayout.mode) map.set(k, c.openingLayout);
    });
  });
  return map;
}

function mergeKeepOpeningLooks(existing, incoming) {
  if (!existing || !incoming) return incoming;
  const looks = collectOpeningLooks(existing);
  if (!looks.size) return incoming;
  const streamers = (incoming.streamers || []).map((s) => Object.assign({}, s, {
    clips: (s.clips || []).map((c) => {
      const kept = looks.get(clipUrlKey(c));
      if (!kept) return c;
      const incomingLook = c.openingLayout;
      if (incomingLook && incomingLook.operatorIntent) {
        return Object.assign({}, c, { openingLayout: incomingLook });
      }
      if (kept.operatorIntent) {
        return Object.assign({}, c, { openingLayout: kept });
      }
      if (incomingLook && incomingLook.mode) {
        return Object.assign({}, c, { openingLayout: incomingLook });
      }
      return Object.assign({}, c, { openingLayout: kept });
    }),
  }));
  const incomingCreative = incoming.compCreative;
  const existingCreative = existing.compCreative;
  const keepExistingCreative = existingCreative && existingCreative.preset === 'fableflow_speed'
    && incomingCreative && incomingCreative.preset === 'classic_blur_pad';
  const compCreative = keepExistingCreative
    ? existingCreative
    : (incomingCreative || existingCreative || null);
  return Object.assign({}, incoming, { streamers, compCreative });
}

function writeOperatorComposerSession(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('composer session payload required');
  }
  const existing = readOperatorComposerSession();
  const merged = mergeKeepOpeningLooks(existing, payload);
  const next = Object.assign({}, merged, {
    version: 1,
    savedAt: Date.now(),
  });
  const incomingLooks = collectOpeningLooks(next);
  const existingLooks = collectOpeningLooks(existing);
  if (existingLooks.size && !incomingLooks.size) {
    return existing;
  }
  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
  fs.writeFileSync(SESSION_PATH, JSON.stringify(next, null, 2));
  return next;
}

function clearOperatorComposerSession() {
  try {
    if (fs.existsSync(SESSION_PATH)) fs.unlinkSync(SESSION_PATH);
  } catch (_) { /* ignore */ }
}

module.exports = {
  SESSION_PATH,
  MAX_AGE_MS,
  sessionPath,
  readOperatorComposerSession,
  writeOperatorComposerSession,
  mergeKeepOpeningLooks,
  clearOperatorComposerSession,
};
