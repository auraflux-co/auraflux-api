/**
 * Live Grid — platform-wide Twitch discovery (CPD-1019)
 * Fills bench from global Helix top streams when follows/roster aren't enough.
 */

const axios = require('axios');

async function fetchPlatformTopLive(opts = {}) {
  const clientId = opts.clientId || process.env.TWITCH_CLIENT_ID;
  const token = (opts.token || process.env.TWITCH_TOKEN || '').replace(/^oauth:/, '');
  if (!clientId || !token) return [];

  const limit = Math.min(Math.max(opts.limit || 100, 1), 100);
  const resp = await axios.get('https://api.twitch.tv/helix/streams', {
    headers: { 'Client-ID': clientId, Authorization: `Bearer ${token}` },
    params: { first: limit },
    timeout: 12_000,
  });
  return (resp.data?.data || []).map(s => ({
    login: String(s.user_login || '').toLowerCase(),
    viewers: s.viewer_count || 0,
    game: s.game_name || '',
    title: s.title || '',
  })).filter(s => s.login);
}

/** Merge follows bench + platform top, dedupe, cap for Helix 100-login limit. */
function mergePlatformBench({ roster = [], follows = [], platform = [], cap = 88 } = {}) {
  const rosterSet = new Set(roster.map(l => String(l).toLowerCase()));
  const out = [];
  const seen = new Set();
  const add = (login) => {
    const l = String(login || '').toLowerCase();
    if (!l || rosterSet.has(l) || seen.has(l)) return;
    seen.add(l);
    out.push(l);
  };
  for (const l of follows || []) add(l);
  const sorted = [...(platform || [])].sort((a, b) => (b.viewers || 0) - (a.viewers || 0));
  for (const s of sorted) add(typeof s === 'string' ? s : s.login);
  return out.sort((a, b) => {
    const pa = sorted.find(s => s.login === a);
    const pb = sorted.find(s => s.login === b);
    return (pb?.viewers || 0) - (pa?.viewers || 0);
  }).slice(0, cap);
}

module.exports = { fetchPlatformTopLive, mergePlatformBench };
