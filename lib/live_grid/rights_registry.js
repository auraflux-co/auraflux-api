/**
 * Platform rules enforcement (CPD-1023) — allowlist from config/live_grid_allowlist.json
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', '..', 'config', 'live_grid_allowlist.json');

function loadAllowlist(configPath = process.env.LIVE_GRID_ALLOWLIST || DEFAULT_PATH) {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function eventAllowed(eventId, config = loadAllowlist()) {
  return (config.events || []).find(e => e.id === eventId) || null;
}

function assertEventAllowed(eventId) {
  if (String(process.env.LIVE_GRID_ALLOWLIST_ENFORCE || 'on').toLowerCase() === 'off') return null;
  const ev = eventAllowed(eventId);
  if (!ev) throw new Error(`event not on allowlist: ${eventId}`);
  return ev;
}

function isTwitchTvPlayable(name, sizeBytes, config = loadAllowlist()) {
  if (!/\.mp4$/i.test(name)) return false;
  const n = String(name).toLowerCase();
  if (/^synth_prebuild/i.test(n) || /_0clips_/i.test(n)) return false;
  const rules = config.twitchTv || {};
  for (const p of rules.blockedPatterns || []) {
    if (n.includes(String(p).toLowerCase())) return false;
  }
  if (sizeBytes != null && sizeBytes < 1_000_000) return false;
  for (const p of rules.allowedPatterns || []) {
    if (n.includes(String(p).toLowerCase())) return true;
  }
  return false;
}

module.exports = {
  loadAllowlist,
  eventAllowed,
  assertEventAllowed,
  isTwitchTvPlayable,
};
