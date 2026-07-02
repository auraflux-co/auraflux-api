'use strict';

/**
 * Resolve dashboard handles / on-air names → canonical Twitch login.
 * Prevents querying the wrong account (e.g. yonna vs yonnajay).
 */

const fs = require('fs');
const path = require('path');

const ROSTER_PATH = path.join(__dirname, '..', 'data', 'streamers.json');
const SOURCES_PATH = path.join(__dirname, '..', 'config', 'streamerSources.json');

let _index = null;

function slug(s) {
  return String(s || '').trim().toLowerCase().replace(/^@/, '').replace(/\s+/g, '');
}

function loadIndex() {
  if (_index) return _index;
  const loginSet = new Set();
  const aliasToLogin = new Map();

  function register(login, { onAir, display } = {}) {
    const canonical = slug(login);
    if (!canonical) return;
    loginSet.add(canonical);
    aliasToLogin.set(canonical, canonical);
    for (const alias of [onAir, display, login]) {
      const key = slug(alias);
      if (!key || key === canonical) continue;
      // First canonical wins — roster is authoritative
      if (!aliasToLogin.has(key)) aliasToLogin.set(key, canonical);
    }
  }

  try {
    const roster = JSON.parse(fs.readFileSync(ROSTER_PATH, 'utf8'));
    for (const s of roster.roster || []) {
      register(s.twitchUsername, { onAir: s.onAirName, display: s.displayName });
    }
  } catch { /* optional */ }

  try {
    const cfg = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
    for (const [login, meta] of Object.entries(cfg.streamers || {})) {
      register(login, { display: meta.displayName });
    }
  } catch { /* optional */ }

  // Explicit traps — truncated / spoken names that match wrong Twitch accounts
  aliasToLogin.set('yonna', 'yonnajay');
  aliasToLogin.set('ron', 'stableronaldo');
  aliasToLogin.set('rage', 'yourragegaming');
  aliasToLogin.set('emily', 'extraemily');
  aliasToLogin.set('jason', 'jasontheween');

  _index = { loginSet, aliasToLogin };
  return _index;
}

/** @returns {string} canonical twitch login */
function resolveTwitchLogin(input) {
  const key = slug(input);
  if (!key) return '';
  const { aliasToLogin, loginSet } = loadIndex();
  if (aliasToLogin.has(key)) return aliasToLogin.get(key);
  if (loginSet.has(key)) return key;
  return key;
}

function resetStreamerLoginIndexForTests() {
  _index = null;
}

module.exports = {
  resolveTwitchLogin,
  resetStreamerLoginIndexForTests,
};
