'use strict';
/**
 * lib/creator_registry/sync.js — Pull follows/subscriptions into the registry
 */

const axios = require('axios');
const { upsertCreator, slugId } = require('./index');

async function syncTwitchFollows() {
  const { getAllFollows } = require('../live_grid/follows');
  const logins = await getAllFollows();
  if (!logins) return { ok: false, error: 'Twitch follows unavailable — connect at /connect/twitch', added: 0, total: 0 };

  let added = 0;
  for (const login of logins) {
    const { created } = upsertCreator({
      id: login,
      displayName: login,
      kind: 'streamer',
      platform: 'twitch',
      platformData: { login: slugId(login) },
      source: 'twitch_follow',
    });
    if (created) added++;
  }
  return { ok: true, platform: 'twitch', added, total: logins.length };
}

async function syncYouTubeSubscriptions() {
  const ytDirect = require('../services/youtube_direct');
  if (!ytDirect.isConnected()) {
    return { ok: false, error: 'YouTube not connected — visit /connect/youtube (includes readonly + subscriptions)', added: 0, total: 0 };
  }

  let accessToken;
  try {
    accessToken = await ytDirect.getAccessToken();
  } catch (e) {
    return { ok: false, error: e.message, added: 0, total: 0 };
  }

  const channels = [];
  let pageToken = null;
  do {
    const res = await axios.get('https://www.googleapis.com/youtube/v3/subscriptions', {
      params: {
        part: 'snippet',
        mine: true,
        maxResults: 50,
        pageToken: pageToken || undefined,
      },
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 20000,
    });
    for (const item of res.data.items || []) {
      const sn = item.snippet || {};
      const ch = sn.resourceId?.channelId;
      const title = sn.title || '';
      const handle = sn.resourceId?.kind === 'youtube#channel' ? ch : null;
      if (ch) channels.push({ channelId: ch, title, description: sn.description || '' });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  let added = 0;
  for (const ch of channels) {
    const id = slugId(ch.title) || ch.channelId;
    const { created } = upsertCreator({
      id,
      displayName: ch.title || id,
      kind: 'streamer',
      platform: 'youtube',
      platformData: {
        channelId: ch.channelId,
        title: ch.title,
        handle: ch.handle || id,
      },
      source: 'youtube_subscription',
    });
    if (created) added++;
  }
  return { ok: true, platform: 'youtube', added, total: channels.length };
}

const KICK_FOLLOWS_TOKEN_PATH = require('path').join(__dirname, '..', '..', 'data', 'kick_follows_token.json');

function loadKickFollowsToken() {
  try { return JSON.parse(require('fs').readFileSync(KICK_FOLLOWS_TOKEN_PATH, 'utf8')); } catch { return null; }
}

function saveKickFollowsToken(data) {
  require('fs').mkdirSync(require('path').dirname(KICK_FOLLOWS_TOKEN_PATH), { recursive: true });
  require('fs').writeFileSync(KICK_FOLLOWS_TOKEN_PATH, JSON.stringify(data, null, 2));
}

function clearKickFollowsToken() {
  try { require('fs').unlinkSync(KICK_FOLLOWS_TOKEN_PATH); } catch { /* absent ok */ }
}

async function disconnectKickFollows() {
  const stored = loadKickFollowsToken();
  if (stored?.access_token) {
    const kickOAuth = require('../publish/adapters/kick_oauth');
    await kickOAuth.revokeToken(stored.access_token, 'access_token');
    if (stored.refresh_token) await kickOAuth.revokeToken(stored.refresh_token, 'refresh_token');
  }
  clearKickFollowsToken();
  return { ok: true, disconnected: true };
}

/** Try known Kick endpoints for followed channels; fail open if unavailable. */
async function syncKickFollows() {
  const stored = loadKickFollowsToken();
  if (!stored?.access_token) {
    return { ok: false, error: 'Kick not connected — visit /connect/kick-follows', added: 0, total: 0 };
  }

  const kickOAuth = require('../publish/adapters/kick_oauth');
  let token = stored.access_token;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  const tryFetch = async (path) => {
    const res = await axios.get(`https://api.kick.com/public/v1${path}`, { headers, timeout: 15000, validateStatus: () => true });
    return res;
  };

  let res = await tryFetch('/channels/followed');
  if (res.status === 401 && stored.refresh_token) {
    try {
      const refreshed = await kickOAuth.refreshAccessToken(stored.refresh_token);
      token = refreshed.access_token;
      saveKickFollowsToken({
        ...stored,
        access_token: token,
        refresh_token: refreshed.refresh_token || stored.refresh_token,
        obtained_at: new Date().toISOString(),
      });
      headers.Authorization = `Bearer ${token}`;
      res = await tryFetch('/channels/followed');
    } catch (e) {
      return { ok: false, error: `Kick token refresh failed: ${e.message}`, added: 0, total: 0 };
    }
  }

  if (res.status === 404 || res.status === 403) {
    return {
      ok: true,
      platform: 'kick',
      added: 0,
      total: 0,
      note: 'Kick follow-list API not available yet — add Kick creators via paste URL; token saved for future sync',
    };
  }
  if (res.status !== 200) {
    return { ok: false, error: `Kick follows API returned ${res.status}`, added: 0, total: 0 };
  }

  const items = res.data?.data || res.data?.channels || (Array.isArray(res.data) ? res.data : []);
  let added = 0;
  for (const item of items) {
    const slug = slugId(item.slug || item.username || item.name || item.channel_slug);
    if (!slug) continue;
    const { created } = upsertCreator({
      id: slug,
      displayName: item.display_name || item.name || slug,
      kind: 'streamer',
      platform: 'kick',
      platformData: { slug, userId: item.user_id || item.id || null },
      source: 'kick_follow',
    });
    if (created) added++;
  }
  return { ok: true, platform: 'kick', added, total: items.length };
}

async function syncAll() {
  const results = {
    twitch: await syncTwitchFollows().catch(e => ({ ok: false, error: e.message, added: 0, total: 0 })),
    youtube: await syncYouTubeSubscriptions().catch(e => ({ ok: false, error: e.message, added: 0, total: 0 })),
    kick: await syncKickFollows().catch(e => ({ ok: false, error: e.message, added: 0, total: 0 })),
  };
  const { getStreamerRosterLogins } = require('./index');
  return { ok: true, results, rosterCount: getStreamerRosterLogins().length };
}

module.exports = {
  syncTwitchFollows,
  syncYouTubeSubscriptions,
  syncKickFollows,
  syncAll,
  loadKickFollowsToken,
  saveKickFollowsToken,
  clearKickFollowsToken,
  disconnectKickFollows,
  KICK_FOLLOWS_TOKEN_PATH,
};
