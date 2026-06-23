'use strict';
/**
 * Browser bundle — keep in sync with lib/clip_picker_groups.js
 */
(function (root) {
  const MAX_STREAMERS_PER_GROUP = 4;
  const STORAGE_KEY = 'CWN_CLIP_PICKER_GROUPS';

  function normalizeHandle(raw) {
    return String(raw || '').trim().toLowerCase().replace(/^@/, '');
  }

  function normalizeGroup(raw) {
    raw = raw || {};
    const streamers = [];
    const seen = {};
    for (let i = 0; i < (raw.streamers || []).length; i++) {
      const h = normalizeHandle(raw.streamers[i]);
      if (!h || seen[h]) continue;
      seen[h] = true;
      streamers.push(h);
      if (streamers.length >= MAX_STREAMERS_PER_GROUP) break;
    }
    const name = String(raw.name || '').trim().slice(0, 48) || 'Untitled group';
    return {
      id: String(raw.id || 'cg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
      name: name,
      streamers: streamers,
      updatedAt: raw.updatedAt || new Date().toISOString(),
    };
  }

  function parseStoredGroups(raw) {
    if (!raw) return [];
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch (e) { return []; }
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeGroup).filter(function (g) { return g.streamers.length > 0; });
  }

  function validateGroup(group) {
    const g = normalizeGroup(group);
    const errors = [];
    if (!g.name.trim()) errors.push('name required');
    if (!g.streamers.length) errors.push('at least one streamer required');
    if (g.streamers.length > MAX_STREAMERS_PER_GROUP) {
      errors.push('max ' + MAX_STREAMERS_PER_GROUP + ' streamers per group');
    }
    return { ok: errors.length === 0, errors: errors, group: g };
  }

  function upsertGroup(groups, group) {
    const v = validateGroup(group);
    if (!v.ok) return { ok: false, errors: v.errors, groups: groups.slice() };
    const g = Object.assign({}, v.group, { updatedAt: new Date().toISOString() });
    const idx = groups.findIndex(function (item) { return item.id === g.id; });
    const next = groups.slice();
    if (idx >= 0) next[idx] = g;
    else next.unshift(g);
    return { ok: true, errors: [], groups: next, group: g };
  }

  function deleteGroup(groups, id) {
    const next = groups.filter(function (g) { return g.id !== id; });
    return { ok: next.length !== groups.length, groups: next };
  }

  function serializeGroups(groups) {
    return JSON.stringify(parseStoredGroups(groups));
  }

  root.ClipPickerGroups = {
    MAX_STREAMERS_PER_GROUP: MAX_STREAMERS_PER_GROUP,
    STORAGE_KEY: STORAGE_KEY,
    normalizeHandle: normalizeHandle,
    normalizeGroup: normalizeGroup,
    parseStoredGroups: parseStoredGroups,
    validateGroup: validateGroup,
    upsertGroup: upsertGroup,
    deleteGroup: deleteGroup,
    serializeGroups: serializeGroups,
  };
}(typeof window !== 'undefined' ? window : globalThis));
