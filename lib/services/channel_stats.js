'use strict';
/**
 * Channel stats — public catalog (Videos + Shorts + Streams) via yt-dlp,
 * optional YouTube Analytics OAuth merge, Upload-Post platform summary.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_DIR = path.join(__dirname, '..', '..', 'data');
const DEFAULT_HANDLE = process.env.YOUTUBE_CHANNEL_HANDLE || 'clipzworldnews';
const CACHE_TTL_MS = Number(process.env.CHANNEL_STATS_CACHE_MS) || 60 * 60 * 1000;
const TABS = ['videos', 'shorts', 'streams'];

function categorizeTitle(title) {
  const t = String(title || '').toLowerCase();
  if (/\b(nba|knicks|celtics|heat|spurs|timberwolves|76ers|highlights|game slate|dyson|kuminga|bitadze|soccer|watch party|pillow|lakers|cavaliers|pistons|thunder|rockets|duke|uconn|notre dame|warriors|nuggets)\b/.test(t)) {
    return 'Sports';
  }
  if (/\b(trump|macron|iran|news roundup|global stories|attorney|ceasefire|bondi|world news|because the light|market recap|protest)\b/.test(t)) {
    return 'News';
  }
  if (/\b(twitch|streamer|vtuber|#lacy|lacy|cinna|jasontheween|jason|stableronaldo|chiefkeef|twitch soup|humbled|gaming|highlight reel|natasha|speed|ishowspeed|kick|multiview|sleep stream|grid|jaycinco|jay cinco|bendadon|yonnajay|marlon|lala baptiste|baby shower|chilling|stream\b|livestream|live stream)\b/.test(t)) {
    return 'Streaming';
  }
  // ClipzWorld channel is streaming-first — only News/Sports get their own bucket
  return 'Streaming';
}

function aggregate(items, keyFn) {
  const out = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!out[key]) out[key] = { count: 0, views: 0, likes: 0 };
    out[key].count += 1;
    out[key].views += item.views || 0;
    out[key].likes += item.likes || 0;
  }
  for (const k of Object.keys(out)) {
    out[k].avgViews = out[k].count ? Math.round(out[k].views / out[k].count) : 0;
  }
  return out;
}

function cachePath(handle) {
  return path.join(CACHE_DIR, `channel_stats_${String(handle).replace(/^@/, '')}.json`);
}

function runYtdlp(args, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', args, { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs }, (err, stdout) => {
      if (err) return reject(new Error(err.message || 'yt-dlp failed'));
      resolve(stdout);
    });
  });
}

async function listTabIds(handle, tab, limit = 50) {
  const url = `https://www.youtube.com/@${String(handle).replace(/^@/, '')}/${tab}`;
  const stdout = await runYtdlp(['--flat-playlist', '-j', '--playlist-end', String(limit), url]);
  const ids = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      if (d.id) ids.push({ id: d.id, title: d.title || '', tab });
    } catch { /* skip */ }
  }
  return ids;
}

async function fetchVideoDetails(entries) {
  if (!entries.length) return [];
  const CHUNK = 8;
  const detailMap = {};
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const urls = chunk.map((e) => `https://www.youtube.com/watch?v=${e.id}`);
    try {
      const stdout = await runYtdlp(['-j', '--no-download', ...urls], 90_000);
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.id) detailMap[d.id] = d;
        } catch { /* skip */ }
      }
    } catch (e) {
      console.warn('[channel_stats] yt-dlp chunk failed:', e.message);
    }
  }

  return entries.map((meta) => {
    const d = detailMap[meta.id];
    if (!d) {
      return { id: meta.id, title: meta.title, tab: meta.tab, error: 'no_detail' };
    }
    const dur = d.duration || 0;
    const liveStatus = d.live_status || '';
    const wasLive = !!d.was_live || ['was_live', 'is_live', 'post_live'].includes(liveStatus);
    const pub = d.upload_date || '';
    const published = pub.length === 8 ? `${pub.slice(0, 4)}-${pub.slice(4, 6)}-${pub.slice(6, 8)}` : pub;
    return {
      id: meta.id,
      title: d.title || meta.title,
      tab: meta.tab,
      category: categorizeTitle(d.title || meta.title),
      durationSec: dur,
      wasLive,
      views: d.view_count || 0,
      likes: d.like_count || 0,
      comments: d.comment_count || 0,
      published,
      url: `https://www.youtube.com/watch?v=${meta.id}`,
    };
  });
}

async function fetchPublicCatalog(handle = DEFAULT_HANDLE) {
  const handleClean = String(handle).replace(/^@/, '');
  const byId = new Map();
  for (const tab of TABS) {
    const listed = await listTabIds(handleClean, tab);
    for (const row of listed) byId.set(row.id, row);
  }
  const items = await fetchVideoDetails([...byId.values()]);
  const ok = items.filter((i) => !i.error);
  let channelTitle = null;
  let subs = null;
  if (ok.length) {
    const sampleId = ok[0].id;
    try {
      const stdout = await runYtdlp(['-j', '--no-download', '--playlist-items', '1', `https://www.youtube.com/@${handleClean}/videos`], 30_000);
      const d = JSON.parse(stdout.split('\n').find(Boolean) || '{}');
      channelTitle = d.channel || d.uploader || null;
      subs = d.channel_follower_count ?? null;
    } catch { /* non-fatal */ }
  }

  const totalViews = ok.reduce((s, i) => s + (i.views || 0), 0);
  return {
    handle: handleClean,
    channelTitle,
    subscriberCount: subs,
    fetchedAt: new Date().toISOString(),
    source: 'yt-dlp',
    totals: {
      items: ok.length,
      views: totalViews,
    },
    byTab: aggregate(ok, (i) => i.tab),
    byCategory: aggregate(ok, (i) => i.category),
    items: ok.sort((a, b) => (b.views || 0) - (a.views || 0)),
  };
}

async function readCache(handle) {
  try {
    const raw = fs.readFileSync(cachePath(handle), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(handle, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(handle), JSON.stringify(data, null, 2));
}

async function getPublicCatalog(handle = DEFAULT_HANDLE, { refresh = false } = {}) {
  if (!refresh) {
    const cached = await readCache(handle);
    if (cached?.catalog?.fetchedAt) {
      const age = Date.now() - new Date(cached.catalog.fetchedAt).getTime();
      if (age < CACHE_TTL_MS) return cached.catalog;
    }
  }
  return fetchPublicCatalog(handle);
}

async function fetchUploadPostSummary(profile = process.env.UPLOADPOST_PROFILE || 'clipzworldnews') {
  const key = process.env.UPLOADPOST_API_KEY;
  if (!key) return { ok: false, error: 'UPLOADPOST_API_KEY not set' };
  try {
    const res = await axios.get(`https://api.upload-post.com/api/analytics/${encodeURIComponent(profile)}`, {
      params: { platforms: 'youtube,tiktok,instagram' },
      headers: { Authorization: `Apikey ${key}` },
      timeout: 20_000,
    });
    return { ok: true, profile, platforms: res.data };
  } catch (e) {
    return { ok: false, error: e.response?.data?.message || e.message };
  }
}

async function buildChannelStatsReport({ handle = DEFAULT_HANDLE, refresh = false } = {}) {
  try {
    const ytDirect = require('./youtube_direct');
    const { fetchPerVideoAnalytics, hasAnalyticsScope } = require('./channel_analytics');

    const tokens = ytDirect.loadTokens();
    const analyticsScope = hasAnalyticsScope(tokens);
    const channelId = tokens?.channelId || null;

    const catalog = await getPublicCatalog(handle, { refresh });

    let analytics = { ok: false, reason: 'not_connected' };
    if (!ytDirect.isConnected()) {
      analytics = {
        ok: false,
        reason: 'not_connected',
        message: 'Connect YouTube OAuth at /connect/youtube for impressions, CTR, and retention.',
        connectUrl: '/connect/youtube',
      };
    } else if (!analyticsScope) {
      analytics = {
        ok: false,
        reason: 'scope_missing',
        message: 'Token missing yt-analytics.readonly — revoke at myaccount.google.com/permissions and reconnect at /connect/youtube',
        connectUrl: '/connect/youtube',
      };
    } else if (channelId) {
      try {
        analytics = await fetchPerVideoAnalytics(channelId, { days: 365 });
      } catch (e) {
        analytics = { ok: false, reason: 'api_error', message: e.message };
      }
    }

    const analyticsMap = {};
    if (analytics.ok && Array.isArray(analytics.videos)) {
      for (const v of analytics.videos) analyticsMap[v.videoId] = v;
    }

    const itemsEnriched = catalog.items.map((item) => {
      const a = analyticsMap[item.id] || null;
      return {
        ...item,
        surface: item.tab,
        published_date: item.published || null,
        engaged_views: a?.engagedViews ?? null,
        avg_percent_viewed: a?.averageViewPercentage ?? null,
        subs_gained: a?.subscribersGained ?? null,
        analytics: a || undefined,
      };
    });

    const uploadPost = await fetchUploadPostSummary();

    const { buildNorthStarBlock } = require('./north_star_stats');
    const { fetchNorthStarAgeAnalytics } = require('./north_star_analytics');

    let ageAnalytics = { ok: false, message: 'Analytics not connected' };
    if (analytics.ok && channelId) {
      try {
        ageAnalytics = await fetchNorthStarAgeAnalytics(channelId, itemsEnriched, { refresh });
      } catch (e) {
        ageAnalytics = { ok: false, message: e.message };
      }
    }

    const northStar = buildNorthStarBlock({
      catalog: { ...catalog, items: itemsEnriched },
      analytics,
      ageAnalytics: analytics.ok ? ageAnalytics : null,
    });

    const report = {
      ok: true,
      handle: catalog.handle,
      channelTitle: catalog.channelTitle || tokens?.channelTitle || null,
      subscriberCount: catalog.subscriberCount,
      fetchedAt: new Date().toISOString(),
      catalog: {
        ...catalog,
        items: itemsEnriched,
      },
      analytics: {
        ...analytics,
        availableMetrics: analytics.ok
          ? ['views', 'engagedViews', 'averageViewDuration', 'averageViewPercentage', 'subscribersGained', 'likes', 'comments', 'shares']
          : [],
      },
      uploadPost,
      northStar,
      dataSources: {
        publicCatalog: 'yt-dlp (Videos + Shorts + Streams tabs — no API key required)',
        privateMetrics: analytics.ok ? 'YouTube Analytics API (OAuth)' : analytics.message || analytics.reason,
        crossPlatform: uploadPost.ok ? 'Upload-Post analytics API' : uploadPost.error,
      },
    };

    await writeCache(handle, report);
    return report;
  } catch (e) {
    const stale = await readCache(handle);
    if (stale?.catalog?.items?.length) {
      return {
        ...stale,
        ok: true,
        stale: true,
        staleError: e.message,
        fetchedAt: stale.fetchedAt || stale.catalog?.fetchedAt,
      };
    }
    throw e;
  }
}

module.exports = {
  categorizeTitle,
  aggregate,
  fetchPublicCatalog,
  getPublicCatalog,
  buildChannelStatsReport,
  fetchUploadPostSummary,
};
