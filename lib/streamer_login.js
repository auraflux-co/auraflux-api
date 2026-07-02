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

/**
 * CPD-1219 — Find roster streamers mentioned in free text (competitor video
 * titles). Matches aliases as whole words or adjacent-word joins ("Extra
 * Emily" → extraemily). Aliases under 4 chars are skipped — traps like
 * 'ron' false-positive on ordinary words.
 * @returns {string[]} canonical twitch logins, deduped
 */
function extractStreamersFromText(text) {
  const { aliasToLogin } = loadIndex();
  const tokens = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return [];
  const candidates = new Set(tokens);
  for (let i = 0; i < tokens.length - 1; i++) {
    candidates.add(tokens[i] + tokens[i + 1]);
  }
  const found = new Set();
  for (const [alias, login] of aliasToLogin) {
    if (alias.length < 4) continue;
    if (candidates.has(alias)) found.add(login);
  }
  return [...found];
}

function resetStreamerLoginIndexForTests() {
  _index = null;
}

module.exports = {
  resolveTwitchLogin,
  extractStreamersFromText,
  resetStreamerLoginIndexForTests,
};
