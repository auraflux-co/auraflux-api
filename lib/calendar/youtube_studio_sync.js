'use strict';

/**
 * Pull future publish times from YouTube Studio (scheduled uploads, Shorts, live).
 * Read-only — does not change Studio; feeds Content Calendar so manual Studio
 * schedules are visible alongside AuraFlux slot assignments.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { nowET } = require('../live_grid/schedule_time');

const CACHE_PATH = path.join(__dirname, '..', '..', 'data', 'youtube_studio_schedule.json');
const CALENDAR_CACHE_PATH = path.join(__dirname, '..', '..', 'data', 'youtube_calendar_items.json');
const CACHE_TTL_MS = Number(process.env.YOUTUBE_STUDIO_SCHEDULE_CACHE_MS) || 15 * 60 * 1000;
const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const DEFAULT_DAYS_AHEAD = Number(process.env.YOUTUBE_STUDIO_SCHEDULE_DAYS) || 90;

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(data) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
}

function formatTimeEt(iso) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

function dateKeyFromIso(iso) {
  return nowET(new Date(iso)).dateKey;
}

function inferContentKind(contentDetails = {}, snippet = {}, liveStreamingDetails = null) {
  if (liveStreamingDetails?.scheduledStartTime) return 'live';
  const dur = String(contentDetails.duration || '');
  if (/^PT(?:[0-5]?\dS|[0-5]?\dM[0-5]?\dS)$/.test(dur)) return 'short';
  const title = String(snippet.title || '').toLowerCase();
  if (title.includes('#shorts') || title.includes('short ')) return 'short';
  if (title.includes('multiview') || title.includes('live')) return 'stream';
  if (title.includes('news') || title.includes('roundup')) return 'news';
  if (title.includes('twitch') || title.includes('soup')) return 'twitch';
  if (title.includes('nba') || title.includes('highlights')) return 'nba';
  return 'video';
}

async function ytGet(accessToken, endpoint, params) {
  const res = await axios.get(`${YT_API_BASE}/${endpoint}`, {
    params,
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 25_000,
  });
  return res.data;
}

async function paginateIds(accessToken, endpoint, params, idField) {
  const ids = [];
  let pageToken;
  for (let page = 0; page < 30; page++) {
    const data = await ytGet(accessToken, endpoint, { ...params, pageToken, maxResults: 50 });
    for (const row of data.items || []) {
      const id = typeof idField === 'function' ? idField(row) : row?.id?.[idField] || row?.[idField];
      if (id) ids.push(id);
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return ids;
}

async function collectVideoIds(accessToken, channel) {
  const uploadsId = channel?.contentDetails?.relatedPlaylists?.uploads;
  const channelId = channel?.id;
  const idSet = new Set();

  if (uploadsId) {
    const uploadIds = await paginateIds(accessToken, 'playlistItems', {
      part: 'contentDetails',
      playlistId: uploadsId,
    }, (row) => row.contentDetails?.videoId);
    uploadIds.forEach((id) => idSet.add(id));
  }

  const mineIds = await paginateIds(accessToken, 'search', {
    part: 'id',
    forMine: true,
    type: 'video',
    order: 'date',
  }, (row) => row.id?.videoId);
  mineIds.forEach((id) => idSet.add(id));

  if (channelId) {
    const upcomingIds = await paginateIds(accessToken, 'search', {
      part: 'id',
      channelId,
      type: 'video',
      eventType: 'upcoming',
    }, (row) => row.id?.videoId);
    upcomingIds.forEach((id) => idSet.add(id));
  }

  return [...idSet];
}

async function fetchVideosBatched(accessToken, videoIds) {
  const videos = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const chunk = videoIds.slice(i, i + 50);
    const data = await ytGet(accessToken, 'videos', {
      part: 'status,snippet,contentDetails,liveStreamingDetails',
      id: chunk.join(','),
    });
    videos.push(...(data.items || []));
  }
  return videos;
}

function readCalendarCache() {
  try {
    return JSON.parse(fs.readFileSync(CALENDAR_CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeCalendarCache(data) {
  fs.mkdirSync(path.dirname(CALENDAR_CACHE_PATH), { recursive: true });
  fs.writeFileSync(CALENDAR_CACHE_PATH, JSON.stringify(data, null, 2));
}

function videoEffectivePublishAt(video) {
  const scheduled = video.status?.publishAt;
  const publicAt = video.snippet?.publishedAt;
  if (scheduled && publicAt) {
    const pubMs = new Date(publicAt).getTime();
    if (pubMs <= Date.now()) return publicAt;
    return scheduled;
  }
  return scheduled || publicAt || null;
}

function calendarStatusFromVideo(video, publishAt) {
  const ms = new Date(publishAt).getTime();
  const privacy = video.status?.privacyStatus || '';
  if (ms > Date.now() && (video.status?.publishAt || privacy === 'private')) return 'scheduled';
  if (privacy === 'public' || privacy === 'unlisted') return 'published';
  if (ms <= Date.now()) return 'published';
  return 'scheduled';
}

function videoToCalendarItem(video, rangeStart, rangeEnd) {
  const publishAt = videoEffectivePublishAt(video);
  if (!publishAt) return null;
  const dateKey = dateKeyFromIso(publishAt);
  if (!dateKey || dateKey < rangeStart || dateKey > rangeEnd) return null;

  const videoId = video.id;
  const liveDetails = video.liveStreamingDetails || null;
  const status = calendarStatusFromVideo(video, publishAt);

  return {
    source: 'youtube_studio',
    videoId,
    title: video.snippet?.title || videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnailUrl: video.snippet?.thumbnails?.medium?.url || video.snippet?.thumbnails?.default?.url || null,
    publishAt,
    dateKey,
    timeEt: formatTimeEt(publishAt),
    privacyStatus: video.status?.privacyStatus || 'unknown',
    kind: inferContentKind(video.contentDetails || {}, video.snippet || {}, liveDetails),
    status,
    liveBroadcast: !!liveDetails?.scheduledStartTime,
  };
}

function broadcastToCalendarItem(broadcast, rangeStart, rangeEnd) {
  const publishAt = broadcast.snippet?.scheduledStartTime;
  if (!publishAt) return null;
  const dateKey = dateKeyFromIso(publishAt);
  if (!dateKey || dateKey < rangeStart || dateKey > rangeEnd) return null;
  const life = broadcast.status?.lifeCycleStatus;
  if (life === 'revoked') return null;

  const boundVideoId = broadcast.contentDetails?.boundStreamId ? null : broadcast.id;
  let status = 'scheduled';
  if (life === 'complete') status = 'published';
  else if (new Date(publishAt).getTime() <= Date.now() && life === 'live') status = 'published';

  return {
    source: 'youtube_studio',
    broadcastId: broadcast.id,
    videoId: boundVideoId,
    title: broadcast.snippet?.title || broadcast.id,
    url: boundVideoId ? `https://www.youtube.com/watch?v=${boundVideoId}` : null,
    thumbnailUrl: broadcast.snippet?.thumbnails?.medium?.url || broadcast.snippet?.thumbnails?.default?.url || null,
    publishAt,
    dateKey,
    timeEt: formatTimeEt(publishAt),
    privacyStatus: broadcast.status?.privacyStatus || 'private',
    kind: 'live',
    status,
    liveBroadcast: true,
    lifeCycleStatus: life,
  };
}

async function fetchCalendarFromApi({ startDate, endDate, persistedJobs = null } = {}) {
  const ytDirect = require('../services/youtube_direct');
  if (!ytDirect.isConnected()) {
    return {
      ok: false,
      reason: 'not_connected',
      message: 'Connect YouTube OAuth at /connect/youtube to sync publish times',
      connectUrl: '/connect/youtube',
      items: [],
    };
  }

  const accessToken = await ytDirect.getAccessToken();
  const chRes = await ytGet(accessToken, 'channels', { part: 'contentDetails,snippet,id', mine: true });
  const channel = chRes?.items?.[0];
  if (!channel) {
    return { ok: false, reason: 'no_channel', message: 'Could not read YouTube channel', items: [] };
  }

  const rangeStart = String(startDate);
  const rangeEnd = String(endDate);

  const videoIds = await collectVideoIds(accessToken, channel);
  const videos = await fetchVideosBatched(accessToken, videoIds);
  const fromVideos = videos
    .map((video) => videoToCalendarItem(video, rangeStart, rangeEnd))
    .filter(Boolean);

  const fromBroadcasts = [];
  let pageToken;
  for (let page = 0; page < 10; page++) {
    const data = await ytGet(accessToken, 'liveBroadcasts', {
      part: 'snippet,status,contentDetails',
      channelId: channel.id,
      broadcastStatus: 'all',
      pageToken,
      maxResults: 50,
    });
    for (const broadcast of data.items || []) {
      const item = broadcastToCalendarItem(broadcast, rangeStart, rangeEnd);
      if (item) fromBroadcasts.push(item);
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  const items = attachJobIdsToYoutubeItems(
    dedupeScheduledItems([...fromVideos, ...fromBroadcasts]),
    persistedJobs,
  );

  return {
    ok: true,
    items,
    channelTitle: channel?.snippet?.title || null,
    channelId: channel?.id || null,
    fetchedAt: new Date().toISOString(),
    rangeStart,
    rangeEnd,
    scan: {
      videoIds: videoIds.length,
      videosScanned: videos.length,
      fromVideos: fromVideos.length,
      fromBroadcasts: fromBroadcasts.length,
      fromAurafluxJobs: 0,
    },
  };
}

function jobYoutubeVideoIdFromCard(card = {}) {
  if (card.youtubeVideoId) return card.youtubeVideoId;
  const candidates = [
    card.gate5Result?.platforms?.youtube?.url,
    card.gate5Result?.platforms?.youtube?.videoId,
    card.publish_results?.youtube?.url,
    card.youtubeUrl,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const s = String(c);
    const m = s.match(/[?&]v=([^&]+)/);
    if (m) return m[1];
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  }
  return null;
}

function attachJobIdsToYoutubeItems(items, persistedJobs = null) {
  let jobsSource = persistedJobs;
  if (!jobsSource) {
    try {
      const jobsPath = path.join(__dirname, '..', '..', 'data', 'jobs.json');
      jobsSource = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
    } catch {
      jobsSource = {};
    }
  }

  const byVideoId = new Map();
  for (const [jobId, card] of Object.entries(jobsSource || {})) {
    if (!card || card.status === 'dismissed') continue;
    const videoId = jobYoutubeVideoIdFromCard(card);
    if (videoId) byVideoId.set(videoId, jobId);
  }

  return (items || []).map((item) => {
    if (item.jobId || !item.videoId) return item;
    const jobId = byVideoId.get(item.videoId);
    return jobId ? { ...item, jobId } : item;
  });
}

/**
 * YouTube publish/schedule times for a calendar date range (past + future).
 */
async function getYoutubeCalendarItems({
  startDate,
  endDate,
  refresh = false,
  persistedJobs = null,
} = {}) {
  const start = String(startDate || '');
  const end = String(endDate || start);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return { ok: false, reason: 'bad_range', message: 'startDate required (YYYY-MM-DD)', items: [] };
  }

  if (!refresh) {
    const cached = readCalendarCache();
    if (
      cached?.fetchedAt
      && Array.isArray(cached.items)
      && cached.rangeStart === start
      && cached.rangeEnd === end
    ) {
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < CACHE_TTL_MS) {
        return { ...cached, ok: cached.ok !== false, stale: false };
      }
    }
  }

  try {
    const fresh = await fetchCalendarFromApi({ startDate: start, endDate: end, persistedJobs });
    const payload = { ...fresh, fetchedAt: fresh.fetchedAt || new Date().toISOString(), rangeStart: start, rangeEnd: end };
    writeCalendarCache(payload);
    return payload;
  } catch (e) {
    const cached = readCalendarCache();
    if (cached?.items?.length && cached.rangeStart === start && cached.rangeEnd === end) {
      return { ...cached, ok: true, stale: true, staleError: e.message };
    }
    return { ok: false, reason: 'api_error', message: e.message, items: [] };
  }
}

function scheduledPublishIso(video) {
  return video.status?.publishAt || video.liveStreamingDetails?.scheduledStartTime || null;
}

function videoToScheduledItem(video, { now, horizon }) {
  const publishAt = scheduledPublishIso(video);
  if (!publishAt) return null;
  const publishMs = new Date(publishAt).getTime();
  if (publishMs <= now || publishMs > horizon) return null;

  const videoId = video.id;
  const liveDetails = video.liveStreamingDetails || null;
  return {
    source: 'youtube_studio',
    videoId,
    title: video.snippet?.title || videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    thumbnailUrl: video.snippet?.thumbnails?.medium?.url || video.snippet?.thumbnails?.default?.url || null,
    publishAt,
    dateKey: dateKeyFromIso(publishAt),
    timeEt: formatTimeEt(publishAt),
    privacyStatus: video.status?.privacyStatus || 'private',
    kind: inferContentKind(video.contentDetails || {}, video.snippet || {}, liveDetails),
    status: liveDetails?.scheduledStartTime ? 'live_scheduled' : 'publish_scheduled',
    liveBroadcast: !!liveDetails?.scheduledStartTime,
  };
}

async function fetchUpcomingBroadcasts(accessToken, channelId, { now, horizon }) {
  if (!channelId) return [];
  const items = [];
  let pageToken;
  for (let page = 0; page < 10; page++) {
    const data = await ytGet(accessToken, 'liveBroadcasts', {
      part: 'snippet,status,contentDetails',
      channelId,
      broadcastStatus: 'all',
      pageToken,
      maxResults: 50,
    });
    for (const broadcast of data.items || []) {
      const publishAt = broadcast.snippet?.scheduledStartTime;
      if (!publishAt) continue;
      const publishMs = new Date(publishAt).getTime();
      if (publishMs <= now || publishMs > horizon) continue;
      const life = broadcast.status?.lifeCycleStatus;
      if (life === 'complete' || life === 'revoked') continue;

      const boundVideoId = broadcast.contentDetails?.boundStreamId ? null : broadcast.id;
      items.push({
        source: 'youtube_studio',
        broadcastId: broadcast.id,
        videoId: boundVideoId,
        title: broadcast.snippet?.title || broadcast.id,
        url: boundVideoId ? `https://www.youtube.com/watch?v=${boundVideoId}` : null,
        thumbnailUrl: broadcast.snippet?.thumbnails?.medium?.url || broadcast.snippet?.thumbnails?.default?.url || null,
        publishAt,
        dateKey: dateKeyFromIso(publishAt),
        timeEt: formatTimeEt(publishAt),
        privacyStatus: broadcast.status?.privacyStatus || 'private',
        kind: 'live',
        status: 'live_scheduled',
        liveBroadcast: true,
        lifeCycleStatus: life,
      });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return items;
}

function collectAurafluxScheduledJobs(persistedJobs = {}, { now, horizon }) {
  const items = [];
  for (const [jobId, card] of Object.entries(persistedJobs || {})) {
    const publishAt = card.scheduledPublishAt;
    if (!publishAt) continue;
    const publishMs = new Date(publishAt).getTime();
    if (publishMs <= now || publishMs > horizon) continue;
    if (card.stage === 'published' || card.finalUrl) continue;

    const title = card.publishCopy?.title || card.title || card.scriptTitle || jobId;
    const ytUrl = card.gate5Result?.platforms?.youtube?.url
      || card.publish_results?.youtube?.url
      || card.youtubeUrl
      || null;
    const videoId = ytUrl ? String(ytUrl).match(/[?&]v=([^&]+)/)?.[1] : null;

    items.push({
      source: 'auraflux',
      jobId,
      videoId,
      title,
      url: ytUrl || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null),
      publishAt,
      dateKey: dateKeyFromIso(publishAt),
      timeEt: formatTimeEt(publishAt),
      privacyStatus: card.nativeScheduledPublish ? 'private' : 'scheduled',
      kind: String(card.contentType || '').includes('short') ? 'short' : (card.contentType || 'video'),
      status: 'publish_scheduled',
      contentType: card.contentType || null,
    });
  }
  return items;
}

function dedupeScheduledItems(items) {
  const seen = new Map();
  for (const item of items) {
    const key = item.videoId
      || item.broadcastId
      || item.jobId
      || `${item.title}|${item.publishAt}`;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, item);
      continue;
    }
    if (prev.source === 'auraflux' && item.source === 'youtube_studio') {
      seen.set(key, { ...prev, ...item, source: 'youtube_studio' });
    }
  }
  return [...seen.values()].sort((a, b) => new Date(a.publishAt) - new Date(b.publishAt));
}

async function fetchScheduledFromApi({ daysAhead = DEFAULT_DAYS_AHEAD, persistedJobs = null } = {}) {
  const ytDirect = require('../services/youtube_direct');
  if (!ytDirect.isConnected()) {
    return {
      ok: false,
      reason: 'not_connected',
      message: 'Connect YouTube OAuth at /connect/youtube to sync Studio schedule',
      connectUrl: '/connect/youtube',
      items: [],
    };
  }

  const accessToken = await ytDirect.getAccessToken();
  const chRes = await ytGet(accessToken, 'channels', { part: 'contentDetails,snippet,id', mine: true });
  const channel = chRes?.items?.[0];
  if (!channel) {
    return { ok: false, reason: 'no_channel', message: 'Could not read YouTube channel', items: [] };
  }

  const now = Date.now();
  const horizon = now + daysAhead * 24 * 60 * 60 * 1000;

  const videoIds = await collectVideoIds(accessToken, channel);
  const videos = await fetchVideosBatched(accessToken, videoIds);
  const fromVideos = videos
    .map((video) => videoToScheduledItem(video, { now, horizon }))
    .filter(Boolean);
  const fromBroadcasts = await fetchUpcomingBroadcasts(accessToken, channel.id, { now, horizon });

  let jobsSource = persistedJobs;
  if (!jobsSource) {
    try {
      const jobsPath = path.join(__dirname, '..', '..', 'data', 'jobs.json');
      jobsSource = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
    } catch {
      jobsSource = {};
    }
  }
  const fromJobs = collectAurafluxScheduledJobs(jobsSource, { now, horizon });

  const items = dedupeScheduledItems([...fromVideos, ...fromBroadcasts, ...fromJobs]);

  return {
    ok: true,
    items,
    channelTitle: channel?.snippet?.title || null,
    channelId: channel?.id || null,
    fetchedAt: new Date().toISOString(),
    daysAhead,
    scan: {
      videoIds: videoIds.length,
      videosScanned: videos.length,
      fromVideos: fromVideos.length,
      fromBroadcasts: fromBroadcasts.length,
      fromAurafluxJobs: fromJobs.length,
    },
  };
}

/**
 * @returns {Promise<{ ok: boolean, items: object[], fetchedAt?: string, stale?: boolean, message?: string }>}
 */
async function getYoutubeStudioSchedule({ refresh = false, daysAhead = DEFAULT_DAYS_AHEAD, persistedJobs = null } = {}) {
  if (!refresh) {
    const cached = readCache();
    if (cached?.fetchedAt && Array.isArray(cached.items)) {
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < CACHE_TTL_MS) {
        return { ...cached, ok: cached.ok !== false, stale: false };
      }
    }
  }

  try {
    const fresh = await fetchScheduledFromApi({ daysAhead, persistedJobs });
    const payload = {
      ...fresh,
      fetchedAt: fresh.fetchedAt || new Date().toISOString(),
    };
    writeCache(payload);
    return payload;
  } catch (e) {
    const cached = readCache();
    if (cached?.items?.length) {
      return {
        ...cached,
        ok: true,
        stale: true,
        staleError: e.message,
      };
    }
    return {
      ok: false,
      reason: 'api_error',
      message: e.message,
      items: [],
    };
  }
}

function groupStudioItemsByDate(items = []) {
  const byDate = {};
  for (const item of items) {
    const dk = item.dateKey;
    if (!dk) continue;
    if (!byDate[dk]) byDate[dk] = [];
    byDate[dk].push(item);
  }
  for (const dk of Object.keys(byDate)) {
    byDate[dk].sort((a, b) => new Date(a.publishAt) - new Date(b.publishAt));
  }
  return byDate;
}

function attachStudioScheduleToWeek(days, studioItems = []) {
  const byDate = groupStudioItemsByDate(studioItems);
  return (days || []).map((day) => ({
    ...day,
    youtubeStudio: byDate[day.date] || [],
  }));
}

module.exports = {
  getYoutubeStudioSchedule,
  getYoutubeCalendarItems,
  attachStudioScheduleToWeek,
  groupStudioItemsByDate,
  dedupeScheduledItems,
  collectAurafluxScheduledJobs,
  formatTimeEt,
  dateKeyFromIso,
  inferContentKind,
  attachJobIdsToYoutubeItems,
  videoEffectivePublishAt,
  videoToCalendarItem,
  CACHE_PATH,
  CALENDAR_CACHE_PATH,
  DEFAULT_DAYS_AHEAD,
};
