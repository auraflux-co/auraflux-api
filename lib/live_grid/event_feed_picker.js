/**
 * Live Grid — pick a live allowlisted feed for event_night Q0 (CPD-1030)
 *
 * Priority: LIVE_GRID_EVENT_FEED_URL → calendar eventFeedUrl → scan config for eventId.
 */

const axios = require('axios');
const { loadFeedSources, isFeedUrlAllowed, normalizeFeedUrl, feedSpecForEvent } = require('./feed_allowlist');
const { fetchPlatformTopLive } = require('./discovery');
const { fetchAllAltPlatformFeeds, detectFeedPlatform } = require('./alt_platform_discovery');

const CACHE_MS = parseInt(process.env.LIVE_GRID_FEED_PICK_CACHE_MS || '300000', 10);
let _cache = { key: '', at: 0, result: null };

function cacheGet(key) {
  if (_cache.key === key && Date.now() - _cache.at < CACHE_MS) return _cache.result;
  return undefined;
}

function cacheSet(key, result) {
  _cache = { key, at: Date.now(), result };
  return result;
}

async function twitchHeaders() {
  const clientId = process.env.TWITCH_CLIENT_ID || process.env.TWITCH_OAUTH_CLIENT_ID;
  const token = (process.env.TWITCH_TOKEN || '').replace(/^oauth:/, '');
  if (!clientId || !token) return null;
  return { 'Client-ID': clientId, Authorization: `Bearer ${token}` };
}

/** Live streams for pinned Twitch logins (cheap Helix call). */
async function fetchTwitchPinFeeds(logins = []) {
  const headers = await twitchHeaders();
  if (!headers || !logins.length) return [];
  const uniq = [...new Set(logins.map(l => String(l).toLowerCase()).filter(Boolean))].slice(0, 100);
  try {
    const resp = await axios.get('https://api.twitch.tv/helix/streams', {
      headers,
      params: { user_login: uniq, first: 100 },
      timeout: 12_000,
    });
    return (resp.data?.data || []).map(s => ({
      platform: 'twitch',
      url: `https://www.twitch.tv/${s.user_login}`,
      title: s.title || s.user_name,
      channel: s.user_name,
      viewers: s.viewer_count || 0,
      game: s.game_name || '',
      source: 'twitch_pin',
    }));
  } catch {
    return [];
  }
}

/** YouTube live search (uses Data API quota — cached). */
async function searchYoutubeLive(query, limit = 8) {
  if (String(process.env.LIVE_GRID_YT_FEED_DISCOVERY || 'on').toLowerCase() === 'off') return [];
  let token;
  try {
    const yt = require('../services/youtube_direct');
    token = await yt.getAccessToken();
  } catch {
    return [];
  }
  try {
    const resp = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        part: 'snippet',
        q: query,
        type: 'video',
        eventType: 'live',
        maxResults: Math.min(limit, 15),
        relevanceLanguage: 'en',
        regionCode: 'US',
      },
      timeout: 15_000,
    });
    return (resp.data?.items || []).map(item => {
      const vid = item.id?.videoId;
      if (!vid) return null;
      const url = `https://www.youtube.com/watch?v=${vid}`;
      if (!isFeedUrlAllowed(url)) return null;
      return {
        platform: 'youtube',
        url,
        title: item.snippet?.title || query,
        channel: item.snippet?.channelTitle || '',
        viewers: 0,
        source: 'youtube_search',
        query,
      };
    }).filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchTwitchGameFeeds(gameNames = [], perGame = 8) {
  const headers = await twitchHeaders();
  if (!headers || !gameNames.length) return [];
  const out = [];
  for (const name of gameNames) {
    try {
      const gr = await axios.get('https://api.twitch.tv/helix/games', {
        headers, params: { name }, timeout: 10_000,
      });
      const gameId = gr.data?.data?.[0]?.id;
      if (!gameId) continue;
      const sr = await axios.get('https://api.twitch.tv/helix/streams', {
        headers, params: { game_id: gameId, first: perGame }, timeout: 12_000,
      });
      for (const s of sr.data?.data || []) {
        out.push({
          platform: 'twitch',
          url: `https://www.twitch.tv/${s.user_login}`,
          title: s.title || s.user_name,
          channel: s.user_login,
          viewers: s.viewer_count || 0,
          game: s.game_name || name,
          source: 'twitch_game',
        });
      }
    } catch (_) {}
  }
  return out;
}

/** Scan global top-live for sports/esports title + game matches (no YouTube quota). */
async function fetchTwitchTopSports(limit = 100, eventId = 'sports_watchalong') {
  const headers = await twitchHeaders();
  if (!headers) return [];
  const sportsRe = eventId === 'esports_grand_final'
    ? /valorant|league of legends|cs2|counter-strike|dota|rocket league|esports|major|iem|finals/i
    : /world cup|fifa|football|soccer|nba|nfl|mlb|ufc|boxing|cricket|sports|ea sports|efootball|brazil|morocco|vs\b|major|iem|watch party|watchparty/i;
  try {
    const resp = await axios.get('https://api.twitch.tv/helix/streams', {
      headers, params: { first: Math.min(limit, 100) }, timeout: 12_000,
    });
    return (resp.data?.data || [])
      .filter(s => sportsRe.test(`${s.game_name} ${s.title}`))
      .map(s => ({
        platform: 'twitch',
        url: `https://www.twitch.tv/${s.user_login}`,
        title: s.title || s.user_name,
        channel: s.user_login,
        viewers: s.viewer_count || 0,
        game: s.game_name || '',
        source: 'twitch_top_sports',
      }));
  } catch {
    return [];
  }
}

async function fetchYoutubeChannelLive(channelId, label = '') {
  if (!channelId) return [];
  return searchYoutubeLive(`${label || channelId} live`, 5).then(list =>
    list.filter(f => f.channel.toLowerCase().includes(String(label).toLowerCase().split(' ')[0] || '____'))
  );
}

function scoreFeed(feed, eventId) {
  let score = feed.viewers || 0;
  const t = `${feed.title || ''} ${feed.channel || ''} ${feed.game || ''}`.toLowerCase();
  if (eventId === 'space_launch' && /space|spacex|nasa|starship|launch|rocket/i.test(t)) score += 50000;
  if (eventId === 'weather_disaster' && /weather|tornado|hurricane|storm|chase/i.test(t)) score += 50000;
  if (eventId === 'esports_grand_final' && /valorant|league|cs2|esports|final|major|iem/i.test(t)) score += 30000;
  if (eventId === 'sports_watchalong' && /world cup|fifa|football|soccer|match|vs\b|major|iem/i.test(t)) score += 30000;
  if (eventId === 'sports_watchalong' && /brazil|morocco|mundial|coupe du monde|world cup|watch party|watchparty/i.test(t)) score += 120000;
  if (eventId === 'gaming_showcase' && /direct|showcase|keynote|fest|nintendo|xbox|playstation/i.test(t)) score += 30000;
  if (/^esl/i.test(String(feed.channel || '')) || feed.channel === 'lcs') score += 15000;
  if (eventId === 'sports_watchalong' && /\[ru\]|\(ru\)|redzone|maincast/i.test(t)) score -= 20000;
  if (feed.platform === 'twitch') score += 500;
  if (['kick', 'trovo', 'dlive', 'rumble', 'chzzk', 'nimo'].includes(feed.platform)) score += 400;
  return score;
}

function pickBest(candidates, eventId) {
  const live = candidates.filter(c => c?.url && isFeedUrlAllowed(c.url));
  if (!live.length) return null;
  live.sort((a, b) => scoreFeed(b, eventId) - scoreFeed(a, eventId));
  return live[0];
}

/**
 * @returns {Promise<{ url, title, channel, platform, source, eventId } | null>}
 */
async function pickEventFeed(opts = {}) {
  const eventId = opts.eventId || opts.activeEvent?.eventId;
  const cacheKey = `${eventId}:${opts.explicitUrl || ''}:${opts.calendarUrl || ''}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const envUrl = normalizeFeedUrl(process.env.LIVE_GRID_EVENT_FEED_URL);
  if (envUrl && isFeedUrlAllowed(envUrl)) {
    return cacheSet(cacheKey, {
      url: envUrl,
      title: opts.eventTitle || 'Live Event Feed',
      channel: 'env',
      platform: detectFeedPlatform(envUrl),
      source: 'env',
      eventId,
    });
  }

  const explicit = normalizeFeedUrl(opts.explicitUrl || opts.calendarUrl || opts.activeEvent?.eventFeedUrl);
  if (explicit && isFeedUrlAllowed(explicit)) {
    return cacheSet(cacheKey, {
      url: explicit,
      title: opts.eventTitle || opts.activeEvent?.eventTitle || 'Live Event Feed',
      channel: 'calendar',
      platform: detectFeedPlatform(explicit),
      source: 'calendar',
      eventId,
    });
  }

  const config = loadFeedSources();
  const id = eventId || config.fallbackEventId || 'sports_watchalong';
  const spec = feedSpecForEvent(id, config) || feedSpecForEvent(config.fallbackEventId, config);
  if (!spec) return cacheSet(cacheKey, null);

  const candidates = [];

  if (spec.twitchPins?.length) {
    candidates.push(...await fetchTwitchPinFeeds(spec.twitchPins));
  }

  for (const ch of spec.youtubeChannels || []) {
    if (ch.id) {
      candidates.push(...await fetchYoutubeChannelLive(ch.id, ch.label || ch.id));
    }
  }

  for (const q of spec.youtubeQueries || []) {
    candidates.push(...await searchYoutubeLive(q, 6));
  }

  // Twitch game/category discovery (works when pins offline + YouTube quota dead)
  if (spec.twitchGames?.length) {
    candidates.push(...await fetchTwitchGameFeeds(spec.twitchGames, 8));
  }
  if (['sports_watchalong', 'esports_grand_final'].includes(id)) {
    candidates.push(...await fetchTwitchTopSports(100, id));
  }

  // Alt platforms (Kick, Trovo, DLive, Rumble, CHZZK, Nimo) — streamlink probe on pins
  candidates.push(...await fetchAllAltPlatformFeeds(spec, config));

  // Legacy: pinned logins in global top-live only
  if (['sports_watchalong', 'esports_grand_final'].includes(id)) {
    const top = await fetchPlatformTopLive({ limit: 100 });
    const pinSet = new Set((spec.twitchPins || []).map(l => l.toLowerCase()));
    for (const s of top) {
      if (!pinSet.has(s.login)) continue;
      candidates.push({
        platform: 'twitch',
        url: `https://www.twitch.tv/${s.login}`,
        title: s.title,
        channel: s.login,
        viewers: s.viewers,
        game: s.game,
        source: 'twitch_top',
      });
    }
  }

  const best = pickBest(candidates, id);
  if (!best) return cacheSet(cacheKey, null);

  const result = {
    url: best.url,
    title: best.title,
    channel: best.channel,
    platform: best.platform,
    source: best.source,
    viewers: best.viewers,
    eventId: id,
    pickedAt: new Date().toISOString(),
  };
  return cacheSet(cacheKey, result);
}

function clearEventFeedCache() {
  _cache = { key: '', at: 0, result: null };
}

module.exports = {
  pickEventFeed,
  fetchTwitchPinFeeds,
  fetchTwitchGameFeeds,
  fetchTwitchTopSports,
  searchYoutubeLive,
  clearEventFeedCache,
  scoreFeed,
  detectFeedPlatform,
};
