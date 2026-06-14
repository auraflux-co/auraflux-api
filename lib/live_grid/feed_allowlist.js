/**
 * Live Grid — allowlisted URL feeds for event_night Q0 (CPD-1030)
 * Blocks wire/premium sports; permits YouTube/Twitch/public NASA-style sources.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', '..', 'config', 'live_grid_feed_sources.json');

function loadFeedSources(configPath = process.env.LIVE_GRID_FEED_SOURCES || DEFAULT_PATH) {
  if (!fs.existsSync(configPath)) return { events: {}, blockedUrlPatterns: [], allowedHostPatterns: [] };
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

function normalizeFeedUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    return u.href;
  } catch {
    return null;
  }
}

function hostAllowed(hostname, config = loadFeedSources()) {
  const host = String(hostname || '').toLowerCase();
  const allowed = config.allowedHostPatterns || ['youtube.com', 'youtu.be', 'twitch.tv', 'nasa.gov'];
  if (!allowed.some(p => host === p || host.endsWith(`.${p}`))) return false;
  const blocked = config.blockedUrlPatterns || [];
  const full = host;
  return !blocked.some(p => full.includes(String(p).toLowerCase()));
}

/** True when URL is on allowlisted host and not a blocked wire/premium path. */
function isFeedUrlAllowed(raw, config = loadFeedSources()) {
  if (String(process.env.LIVE_GRID_FEED_ALLOWLIST_ENFORCE || 'on').toLowerCase() === 'off') {
    return !!normalizeFeedUrl(raw);
  }
  const url = normalizeFeedUrl(raw);
  if (!url) return false;
  try {
    const u = new URL(url);
    if (!hostAllowed(u.hostname, config)) return false;
    const hay = `${u.hostname}${u.pathname}`.toLowerCase();
    for (const p of config.blockedUrlPatterns || []) {
      if (hay.includes(String(p).toLowerCase())) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function assertFeedUrlAllowed(raw) {
  if (!isFeedUrlAllowed(raw)) throw new Error(`feed URL not allowlisted: ${raw}`);
  return normalizeFeedUrl(raw);
}

function feedSpecForEvent(eventId, config = loadFeedSources()) {
  return config.events?.[eventId] || null;
}

module.exports = {
  loadFeedSources,
  normalizeFeedUrl,
  isFeedUrlAllowed,
  assertFeedUrlAllowed,
  feedSpecForEvent,
  DEFAULT_PATH,
};
