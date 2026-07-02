'use strict';
/**
 * Persist Library clip checkbox state across Load library / navigation.
 */

const STORAGE_KEY = 'CWN_LIBRARY_CLIP_PICKS';

function normalizeLogin(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^@/, '').replace(/\s+/g, '');
}

function parseStored(raw) {
  if (!raw) return null;
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch (_) { return null; }
  }
  if (!data || typeof data !== 'object' || !data.streamers) return null;
  return data;
}

function serializePicks(streamers, meta = {}) {
  const streamersOut = {};
  (streamers || []).forEach((entry) => {
    const login = normalizeLogin(entry.name);
    if (!login) return;
    const selectedClips = (entry.clips || []).filter((c) => c.selected).map((c) => ({
      url: c.url || '',
      title: c.title || '',
    }));
    if (!selectedClips.length && !entry.selected) return;
    streamersOut[login] = {
      selected: entry.selected !== false,
      collapsed: !!entry.collapsed,
      clips: selectedClips,
    };
  });
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    groupId: meta.groupId || null,
    streamerLogins: (meta.streamerLogins || []).map(normalizeLogin).filter(Boolean),
    streamers: streamersOut,
  };
}

function applyPicks(streamers, saved) {
  const snap = parseStored(saved);
  if (!snap?.streamers || !Array.isArray(streamers)) return streamers;
  const map = snap.streamers;
  streamers.forEach((entry) => {
    const login = normalizeLogin(entry.name);
    const row = map[login];
    if (!row) return;
    entry.selected = row.selected !== false;
    entry.collapsed = !!row.collapsed;
    const urls = {};
    (row.clips || []).forEach((c) => { if (c.url) urls[c.url] = true; });
    (entry.clips || []).forEach((c) => {
      if (urls[c.url]) c.selected = true;
    });
    if (entry.clipsRaw) {
      entry.clipsRaw.forEach((c) => {
        if (urls[c.url]) c.selected = true;
      });
    }
  });
  return streamers;
}

function countSavedClips(saved) {
  const snap = parseStored(saved);
  if (!snap?.streamers) return 0;
  let n = 0;
  Object.values(snap.streamers).forEach((row) => {
    n += (row.clips || []).length;
  });
  return n;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STORAGE_KEY,
    normalizeLogin,
    parseStored,
    serializePicks,
    applyPicks,
    countSavedClips,
  };
}

if (typeof window !== 'undefined') {
  window.LibraryClipPicks = {
    STORAGE_KEY,
    normalizeLogin,
    parseStored,
    serializePicks,
    applyPicks,
    countSavedClips,
  };
}
