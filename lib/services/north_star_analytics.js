'use strict';

const fs = require('fs');
const path = require('path');
const { getAccessToken, loadTokens } = require('./youtube_direct');
const {
  hasAnalyticsScope,
  hasMonetaryScope,
  fetchAnalyticsReport,
  rowsToObjects,
} = require('./channel_analytics');
const { aggregateAgeRows, yesterdayYmd, parseYmd } = require('./north_star_stats');
const { getNorthStarConfig } = require('./north_star_config');

const CACHE_DIR = path.join(__dirname, '..', '..', 'data');
const CACHE_TTL_MS = Number(process.env.CWN_NORTH_STAR_CACHE_MS) || 24 * 60 * 60 * 1000;

function cachePath(handle) {
  return path.join(CACHE_DIR, `north_star_age_${String(handle).replace(/^@/, '')}.json`);
}

function readAgeCache(handle) {
  try {
    return JSON.parse(fs.readFileSync(cachePath(handle), 'utf8'));
  } catch {
    return null;
  }
}

function writeAgeCache(handle, data) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(handle), JSON.stringify(data, null, 2));
}

function ymdAddDays(ymd, delta) {
  const t = parseYmd(ymd);
  if (t == null) return null;
  return new Date(t + delta * 86_400_000).toISOString().slice(0, 10);
}

function listDaysInclusive(startDate, endDate) {
  const days = [];
  let day = startDate;
  while (day && day <= endDate) {
    days.push(day);
    const next = ymdAddDays(day, 1);
    if (!next || next === day) break;
    day = next;
  }
  return days;
}

function formatAnalyticsError(err) {
  const apiMsg = err?.response?.data?.error?.message;
  if (apiMsg) return apiMsg;
  if (String(err?.message || '').includes('400')) {
    return 'YouTube Analytics rejected the age-matrix query — retry after refresh.';
  }
  return err?.message || 'Age matrix fetch failed';
}

/**
 * Per-day video queries — YouTube Analytics v2 does NOT support dimensions=day,video.
 * One query per calendar day (dimensions=video, startDate=endDate=day).
 */
async function fetchVideoDayViews(channelId, startDate, endDate, { includeRevenue = false } = {}) {
  const accessToken = await getAccessToken();
  const metrics = includeRevenue ? 'views,estimatedRevenue' : 'views';
  const allRows = [];
  const days = listDaysInclusive(startDate, endDate);

  for (const day of days) {
    let startIndex = 1;
    while (startIndex <= 2001) {
      const data = await fetchAnalyticsReport(accessToken, {
        ids: `channel==${channelId}`,
        startDate: day,
        endDate: day,
        metrics,
        dimensions: 'video',
        sort: '-views',
        maxResults: 200,
        startIndex,
      });
      const rows = rowsToObjects(data);
      for (const row of rows) {
        allRows.push({
          day,
          video: row.video,
          views: row.views,
          estimatedRevenue: row.estimatedRevenue,
        });
      }
      if (rows.length < 200) break;
      startIndex += 200;
    }
  }

  return allRows;
}

/**
 * Pull day×video Analytics rows and compute age matrix + RPM for north star dashboard.
 */
async function fetchNorthStarAgeAnalytics(channelId, catalogItems, opts = {}) {
  const tokens = loadTokens();
  if (!hasAnalyticsScope(tokens)) {
    return {
      ok: false,
      reason: 'scope_missing',
      message: 'OAuth token missing yt-analytics.readonly',
    };
  }

  const handle = process.env.YOUTUBE_CHANNEL_HANDLE || 'clipzworldnews';
  const config = getNorthStarConfig();
  const days = opts.days || config.ageMatrixDays;
  const endDate = opts.endDate || new Date().toISOString().slice(0, 10);
  const startDate = opts.startDate || ymdAddDays(endDate, -(days - 1));

  if (!opts.refresh) {
    const cached = readAgeCache(handle);
    if (cached?.fetchedAt && cached.startDate === startDate && cached.endDate === endDate) {
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < CACHE_TTL_MS) {
        return { ...cached, ok: true, fromCache: true };
      }
    }
  }

  try {
    const includeRevenue = hasMonetaryScope(tokens);
    const videoDayRows = await fetchVideoDayViews(channelId, startDate, endDate, { includeRevenue });
    const focusDate = yesterdayYmd();
    const aggregated = aggregateAgeRows(videoDayRows, catalogItems, { focusDate });

    const result = {
      ok: true,
      fetchedAt: new Date().toISOString(),
      startDate,
      endDate,
      focusDate,
      rowCount: videoDayRows.length,
      queryMode: 'per_day_video',
      includeRevenue,
      hasRevenue: aggregated.hasRevenue,
      ...aggregated,
    };

    writeAgeCache(handle, result);
    return result;
  } catch (err) {
    return {
      ok: false,
      message: formatAnalyticsError(err),
    };
  }
}

module.exports = {
  fetchVideoDayViews,
  fetchNorthStarAgeAnalytics,
  readAgeCache,
  listDaysInclusive,
};
