'use strict';
/**
 * lib/clip_picker_groups.js — Saved clip-picker groups (4-creator packs).
 * Browser + Node: groups only affect #twitch-streamers selection, not roster buckets.
 */

const MAX_STREAMERS_PER_GROUP = 4;
const STORAGE_KEY = 'CWN_CLIP_PICKER_GROUPS';

function normalizeHandle(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^@/, '');
}

function normalizeGroup(raw = {}) {
  const streamers = [];
  const seen = {};
  for (const item of (Array.isArray(raw.streamers) ? raw.streamers : [])) {
    const h = normalizeHandle(item);
    if (!h || seen[h]) continue;
    seen[h] = true;
    streamers.push(h);
    if (streamers.length >= MAX_STREAMERS_PER_GROUP) break;
  }
  const name = String(raw.name || '').trim().slice(0, 48) || 'Untitled group';
  return {
    id: String(raw.id || `cg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
    name,
    streamers,
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
}

function parseStoredGroups(raw) {
  if (!raw) return [];
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch (_) { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(normalizeGroup).filter((g) => g.streamers.length > 0);
}

function validateGroup(group) {
  const g = normalizeGroup(group);
  const errors = [];
  if (!g.name.trim()) errors.push('name required');
  if (!g.streamers.length) errors.push('at least one streamer required');
  if (g.streamers.length > MAX_STREAMERS_PER_GROUP) {
    errors.push(`max ${MAX_STREAMERS_PER_GROUP} streamers per group`);
  }
  return { ok: errors.length === 0, errors, group: g };
}

function upsertGroup(groups, group) {
  const v = validateGroup(group);
  if (!v.ok) return { ok: false, errors: v.errors, groups: groups.slice() };
  const g = { ...v.group, updatedAt: new Date().toISOString() };
  const idx = groups.findIndex((item) => item.id === g.id);
  const next = groups.slice();
  if (idx >= 0) next[idx] = g;
  else next.unshift(g);
  return { ok: true, errors: [], groups: next, group: g };
}

function deleteGroup(groups, id) {
  const next = groups.filter((g) => g.id !== id);
  return { ok: next.length !== groups.length, groups: next };
}

function serializeGroups(groups) {
  return JSON.stringify(parseStoredGroups(groups));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MAX_STREAMERS_PER_GROUP,
    STORAGE_KEY,
    normalizeHandle,
    normalizeGroup,
    parseStoredGroups,
    validateGroup,
    upsertGroup,
    deleteGroup,
    serializeGroups,
  };
}

if (typeof window !== 'undefined') {
  window.ClipPickerGroups = {
    MAX_STREAMERS_PER_GROUP,
    STORAGE_KEY,
    normalizeHandle,
    normalizeGroup,
    parseStoredGroups,
    validateGroup,
    upsertGroup,
    deleteGroup,
    serializeGroups,
  };
}
