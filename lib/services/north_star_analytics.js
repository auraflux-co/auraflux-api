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
const { aggregateAgeRows, yesterdayYmd } = require('./north_star_stats');
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

async function fetchVideoDayViews(channelId, startDate, endDate, { includeRevenue = false } = {}) {
  const accessToken = await getAccessToken();
  const metrics = includeRevenue ? 'views,estimatedRevenue' : 'views';
  const allRows = [];
  let startIndex = 1;
  const maxResults = 200;

  while (startIndex <= 2001) {
    const data = await fetchAnalyticsReport(accessToken, {
      ids: `channel==${channelId}`,
      startDate,
      endDate,
      metrics,
      dimensions: 'day,video',
      sort: 'day',
      maxResults,
      startIndex,
    });
    const rows = rowsToObjects(data);
    allRows.push(...rows);
    if (rows.length < maxResults) break;
    startIndex += maxResults;
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
  const startDate = opts.startDate || (() => {
    const d = new Date(endDate + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - (days - 1));
    return d.toISOString().slice(0, 10);
  })();

  if (!opts.refresh) {
    const cached = readAgeCache(handle);
    if (cached?.fetchedAt && cached.startDate === startDate && cached.endDate === endDate) {
      const age = Date.now() - new Date(cached.fetchedAt).getTime();
      if (age < CACHE_TTL_MS) {
        return { ...cached, ok: true, fromCache: true };
      }
    }
  }

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
    includeRevenue,
    hasRevenue: aggregated.hasRevenue,
    ...aggregated,
  };

  writeAgeCache(handle, result);
  return result;
}

module.exports = {
  fetchVideoDayViews,
  fetchNorthStarAgeAnalytics,
  readAgeCache,
};
