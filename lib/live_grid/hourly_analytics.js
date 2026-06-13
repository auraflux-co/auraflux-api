/**
 * YouTube hourly watch analytics + schedule recommendation (CPD-1024)
 */

const axios = require('axios');
const { getAccessToken } = require('../services/youtube_direct');

const YT_ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2/reports';

async function fetchHourlyWatch(channelId, opts = {}) {
  const accessToken = await getAccessToken();
  const end = opts.endDate || new Date().toISOString().slice(0, 10);
  const start = opts.startDate || (() => {
    const d = new Date();
    d.setDate(d.getDate() - (opts.days || 7));
    return d.toISOString().slice(0, 10);
  })();

  const res = await axios.get(YT_ANALYTICS, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: {
      ids: `channel==${channelId}`,
      startDate: start,
      endDate: end,
      metrics: 'views,estimatedMinutesWatched,averageViewDuration',
      dimensions: 'day,hour',
      sort: 'day,hour',
    },
    timeout: 20_000,
  });
  const rows = res.data?.rows || [];
  return rows.map(r => ({
    day: r[0],
    hour: r[1],
    views: r[2] || 0,
    estimatedMinutesWatched: r[3] || 0,
    averageViewDuration: r[4] || 0,
  }));
}

/** Aggregate by hour-of-day (0-23) across days. */
function aggregateByHour(rows) {
  const buckets = Array.from({ length: 24 }, (_, h) => ({
    hour: h, views: 0, estimatedMinutesWatched: 0, samples: 0,
  }));
  for (const r of rows || []) {
    const h = Number(r.hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) continue;
    buckets[h].views += r.views || 0;
    buckets[h].estimatedMinutesWatched += r.estimatedMinutesWatched || 0;
    buckets[h].samples += 1;
  }
  return buckets;
}

/** Recommend top contiguous window for live grid (ET hours). */
function recommendGridWindow(hourlyBuckets, { minHours = 6, maxHours = 12 } = {}) {
  const scores = hourlyBuckets.map(b => b.estimatedMinutesWatched || b.views || 0);
  let best = { start: 18, end: 3, score: -1, totalMinutes: 0 };
  for (let len = minHours; len <= maxHours; len++) {
    for (let start = 0; start < 24; start++) {
      let total = 0;
      for (let i = 0; i < len; i++) total += scores[(start + i) % 24];
      if (total > best.score) {
        best = {
          start,
          end: (start + len) % 24,
          score: total,
          totalMinutes: total,
          lengthHours: len,
        };
      }
    }
  }
  const fmt = h => `${String(h).padStart(2, '0')}:00`;
  return {
    ...best,
    windowEt: `${fmt(best.start)}-${fmt(best.end)}`,
    note: 'Based on estimatedMinutesWatched by hour (ET). Use 00:00-24:00 during 24h measurement runs.',
  };
}

module.exports = {
  fetchHourlyWatch,
  aggregateByHour,
  recommendGridWindow,
};
