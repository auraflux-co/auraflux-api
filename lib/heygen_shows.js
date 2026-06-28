'use strict';

/**
 * Env-driven HeyGen show → avatar mapping (CPD-1131).
 * Default Talk Soup uses HEYGEN_AVATAR_ID; additional shows add HEYGEN_AVATAR_SHOW_<SLUG>_ID.
 */

const fs = require('fs');
const path = require('path');

function loadCustomerConfig(customerId = 'c0') {
  try {
    const p = path.join(__dirname, '..', 'config', 'customers', `${customerId}.json`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function loadHeygenShows(customerId = 'c0') {
  const cfg = loadCustomerConfig(customerId);
  const shows = cfg?.templates?.['long-form']?.designDefaults?.heygenShows
    || cfg?.designDefaults?.heygenShows
    || {};
  if (Object.keys(shows).length) return shows;
  return {
    talkSoup: {
      label: 'Talk Soup',
      avatarEnv: 'HEYGEN_AVATAR_ID',
      voiceEnv: 'HEYGEN_VOICE_ID',
      heygenFolder: 'TalkSoup',
      default: true,
    },
  };
}

function resolveEnvRef(envKey) {
  if (!envKey) return null;
  const val = process.env[envKey];
  return val && String(val).trim() ? String(val).trim() : null;
}

function resolveHeygenShow({ customerId = 'c0', showKey, card } = {}) {
  const shows = loadHeygenShows(customerId);
  const key = showKey
    || card?.heygenShowKey
    || card?.showKey
    || Object.keys(shows).find((k) => shows[k]?.default)
    || 'talkSoup';
  const show = shows[key];
  if (!show) {
    return {
      ok: false,
      showKey: key,
      error: `Unknown HeyGen show "${key}" — add to config/customers/${customerId}.json heygenShows`,
    };
  }
  const avatarId = resolveEnvRef(show.avatarEnv);
  const voiceId = resolveEnvRef(show.voiceEnv || 'HEYGEN_VOICE_ID');
  if (!avatarId) {
    return {
      ok: false,
      showKey: key,
      error: `Missing env ${show.avatarEnv} for show "${show.label || key}"`,
    };
  }
  return {
    ok: true,
    showKey: key,
    label: show.label || key,
    avatarId,
    voiceId,
    heygenFolder: show.heygenFolder || show.label || key,
    avatarEnv: show.avatarEnv,
  };
}

function heygenShowPreflight({ customerId = 'c0', showKey, card } = {}) {
  const resolved = resolveHeygenShow({ customerId, showKey, card });
  if (!resolved.ok) return { ok: false, blockers: [resolved.error], show: resolved };
  return {
    ok: true,
    show: resolved,
    blockers: [],
    summary: `${resolved.label} · avatar ${resolved.avatarId.slice(0, 8)}… · folder ${resolved.heygenFolder}`,
  };
}

module.exports = {
  loadHeygenShows,
  resolveHeygenShow,
  resolveEnvRef,
  heygenShowPreflight,
};
