'use strict';
/**
 * Browser bundle — keep in sync with lib/library_clip_picks.js
 */
(function (root) {
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

  function serializePicks(streamers, meta) {
    meta = meta || {};
    const streamersOut = {};
    (streamers || []).forEach(function (entry) {
      const login = normalizeLogin(entry.name);
      if (!login) return;
      const selectedClips = (entry.clips || []).filter(function (c) { return c.selected; }).map(function (c) {
        return { url: c.url || '', title: c.title || '' };
      });
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
    if (!snap || !snap.streamers || !Array.isArray(streamers)) return streamers;
    const map = snap.streamers;
    streamers.forEach(function (entry) {
      const login = normalizeLogin(entry.name);
      const row = map[login];
      if (!row) return;
      entry.selected = row.selected !== false;
      entry.collapsed = !!row.collapsed;
      const urls = {};
      (row.clips || []).forEach(function (c) { if (c.url) urls[c.url] = true; });
      (entry.clips || []).forEach(function (c) {
        if (urls[c.url]) c.selected = true;
      });
      if (entry.clipsRaw) {
        entry.clipsRaw.forEach(function (c) {
          if (urls[c.url]) c.selected = true;
        });
      }
    });
    return streamers;
  }

  function countSavedClips(saved) {
    const snap = parseStored(saved);
    if (!snap || !snap.streamers) return 0;
    var n = 0;
    Object.keys(snap.streamers).forEach(function (k) {
      n += (snap.streamers[k].clips || []).length;
    });
    return n;
  }

  root.LibraryClipPicks = {
    STORAGE_KEY: STORAGE_KEY,
    normalizeLogin: normalizeLogin,
    parseStored: parseStored,
    serializePicks: serializePicks,
    applyPicks: applyPicks,
    countSavedClips: countSavedClips,
  };
})(typeof window !== 'undefined' ? window : globalThis);
