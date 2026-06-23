'use strict';

const { getNorthStarConfig } = require('./north_star_config');

const SURFACES = ['shorts', 'videos', 'streams'];
const AGE_BUCKETS = ['day1', 'day2', 'day3', 'day4plus'];

function parseYmd(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function daysBetween(laterYmd, earlierYmd) {
  const a = parseYmd(laterYmd);
  const b = parseYmd(earlierYmd);
  if (a == null || b == null) return null;
  return Math.round((a - b) / 86_400_000);
}

function ageBucket(ageDays) {
  if (ageDays == null || ageDays < 0) return null;
  if (ageDays === 0) return 'day1';
  if (ageDays === 1) return 'day2';
  if (ageDays === 2) return 'day3';
  return 'day4plus';
}

function emptyAgeMatrix() {
  const m = {};
  for (const s of SURFACES) {
    m[s] = { day1: 0, day2: 0, day3: 0, day4plus: 0 };
  }
  return m;
}

function initShortsDecay() {
  return { d1: 0, d2: 0, d3: 0, d4: 0, d5: 0, d6: 0, d7: 0 };
}

function ymdAddDays(ymd, delta) {
  const t = parseYmd(ymd);
  if (t == null) return null;
  const d = new Date(t + delta * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function yesterdayYmd() {
  return ymdAddDays(new Date().toISOString().slice(0, 10), -1);
}

function computeCadenceFromCatalog(items, windowDays = 7) {
  const today = new Date().toISOString().slice(0, 10);
  const start = ymdAddDays(today, -(windowDays - 1));
  const byDay = {};
  const totals = { shorts: 0, videos: 0, streams: 0 };

  for (const item of items || []) {
    const pub = item.published || item.published_date;
    if (!pub || pub < start || pub > today) continue;
    const tab = item.tab || item.surface;
    if (!SURFACES.includes(tab)) continue;
    if (!byDay[pub]) byDay[pub] = { shorts: 0, videos: 0, streams: 0 };
    byDay[pub][tab] += 1;
    totals[tab] += 1;
  }

  const daysWithData = Math.max(1, Object.keys(byDay).length);
  const avgPerDay = {
    shorts: totals.shorts / windowDays,
    videos: totals.videos / windowDays,
    streams: totals.streams / windowDays,
  };

  const yday = yesterdayYmd();
  const yesterday = byDay[yday] || { shorts: 0, videos: 0, streams: 0 };

  return { windowDays, start, end: today, byDay, yesterday, totals, avgPerDay, daysWithData };
}

function cadenceAlerts(cadence, targets) {
  const alerts = [];
  const labels = { shorts: 'Shorts', videos: 'VODs', streams: 'Lives' };
  for (const surface of SURFACES) {
    const t = targets[surface];
    const avg = cadence.avgPerDay[surface];
    if (avg < t.min) {
      alerts.push({
        surface,
        level: 'warn',
        message: `${labels[surface]} avg ${avg.toFixed(1)}/day — target ${t.min}–${t.max}`,
      });
    } else if (avg > t.max) {
      alerts.push({
        surface,
        level: 'info',
        message: `${labels[surface]} avg ${avg.toFixed(1)}/day — above target ${t.max}`,
      });
    }
  }
  return alerts;
}

function computeDailyTrend(channelSummary, windowDays = 28) {
  const rows = channelSummary?.daily || [];
  if (!rows.length) return { days: [], totals: null, avgDailyViews: 0, avgDailyRevenue: null };

  const slice = rows.slice(-windowDays);
  const totals = slice.reduce(
    (acc, r) => {
      acc.views += r.views || 0;
      acc.engagedViews += r.engagedViews || 0;
      acc.subscribersGained += r.subscribersGained || 0;
      if (r.estimatedRevenue != null) acc.estimatedRevenue += r.estimatedRevenue || 0;
      return acc;
    },
    { views: 0, engagedViews: 0, subscribersGained: 0, estimatedRevenue: 0 }
  );

  const n = slice.length || 1;
  const hasRevenue = slice.some((r) => r.estimatedRevenue != null && r.estimatedRevenue > 0);

  return {
    days: slice.map((r) => ({
      day: r.day,
      views: r.views || 0,
      estimatedRevenue: r.estimatedRevenue ?? null,
      subscribersGained: r.subscribersGained || 0,
    })),
    totals,
    avgDailyViews: totals.views / n,
    avgDailyRevenue: hasRevenue ? totals.estimatedRevenue / n : null,
  };
}

function computeProgress({ trend, yesterdayViews, yesterdayRevenue, config, monetaryAvailable }) {
  const target = config.dailyUsdTarget;
  let mode = 'views_proxy';
  let pctOfTarget = 0;
  let avgDailyUsd = null;
  let yesterdayUsd = null;

  if (monetaryAvailable && trend.avgDailyRevenue != null) {
    mode = 'revenue';
    avgDailyUsd = trend.avgDailyRevenue;
    yesterdayUsd = yesterdayRevenue;
    pctOfTarget = target > 0 ? Math.min(100, (avgDailyUsd / target) * 100) : 0;
  } else {
    const proxyViews = config.viewsProxyPerDay;
    pctOfTarget = proxyViews > 0 ? Math.min(100, (trend.avgDailyViews / proxyViews) * 100) : 0;
  }

  return {
    mode,
    targetUsd: target,
    pctOfTarget: Math.round(pctOfTarget * 10) / 10,
    avgDailyUsd,
    yesterdayUsd,
    avgDailyViews: Math.round(trend.avgDailyViews),
    yesterdayViews: yesterdayViews ?? null,
    viewsProxyPerDay: config.viewsProxyPerDay,
  };
}

function aggregateAgeRows(videoDayRows, catalogItems, { focusDate } = {}) {
  const pubMap = {};
  for (const item of catalogItems || []) {
    pubMap[item.id] = { tab: item.tab || item.surface, published: item.published || item.published_date };
  }

  const period = emptyAgeMatrix();
  const focus = focusDate ? emptyAgeMatrix() : null;
  const shortsDecay = initShortsDecay();
  const rpm = {
    shorts: { views: 0, revenue: 0 },
    videos: { views: 0, revenue: 0 },
    streams: { views: 0, revenue: 0 },
  };

  let totalViews = 0;
  let catalogViews = 0;

  for (const row of videoDayRows || []) {
    const meta = pubMap[row.video];
    if (!meta?.published) continue;
    const age = daysBetween(row.day, meta.published);
    const bucket = ageBucket(age);
    const surface = meta.tab;
    if (!bucket || !SURFACES.includes(surface)) continue;

    const views = Number(row.views) || 0;
    const revenue = Number(row.estimatedRevenue) || 0;

    period[surface][bucket] += views;
    totalViews += views;
    if (bucket === 'day4plus') catalogViews += views;

    if (focus && row.day === focusDate) {
      focus[surface][bucket] += views;
    }

    if (surface === 'shorts' && age != null && age >= 0 && age <= 6) {
      const key = `d${age + 1}`;
      shortsDecay[key] += views;
    }

    rpm[surface].views += views;
    rpm[surface].revenue += revenue;
  }

  const formatRpm = {};
  for (const s of SURFACES) {
    const v = rpm[s].views;
    formatRpm[s] = v > 0 && rpm[s].revenue > 0
      ? Math.round((rpm[s].revenue / v) * 1000 * 100) / 100
      : null;
  }

  return {
    periodMatrix: period,
    focusMatrix: focus,
    shortsDecay,
    backCatalogRatio: totalViews > 0 ? Math.round((catalogViews / totalViews) * 1000) / 1000 : null,
    totalViews,
    catalogViews,
    formatRpm,
    hasRevenue: Object.values(rpm).some((r) => r.revenue > 0),
  };
}

function buildNorthStarBlock({ catalog, analytics, ageAnalytics, config: cfgIn }) {
  const config = cfgIn || getNorthStarConfig();
  const items = catalog?.items || [];
  const windowDays = config.analyticsWindowDays;

  let channelSummary = analytics?.channelSummary;
  if (analytics?.ok && !channelSummary) {
    channelSummary = { daily: [], totals: {} };
  }

  const trend = computeDailyTrend(channelSummary, windowDays);
  const cadence = computeCadenceFromCatalog(items, 7);
  const alerts = cadenceAlerts(cadence, config.cadence);

  const yday = yesterdayYmd();
  const ydayRow = (channelSummary?.daily || []).find((r) => r.day === yday);
  const yesterdayViews = ydayRow?.views ?? null;
  const yesterdayRevenue = ydayRow?.estimatedRevenue ?? null;

  const monetaryAvailable = !!(ageAnalytics?.hasRevenue || trend.days.some((d) => d.estimatedRevenue > 0));
  const progress = computeProgress({
    trend,
    yesterdayViews,
    yesterdayRevenue,
    config,
    monetaryAvailable,
  });

  const northStar = {
    config: {
      dailyUsdTarget: config.dailyUsdTarget,
      cadence: config.cadence,
      backCatalogTargetPct: config.backCatalogTargetPct,
      windowDays,
    },
    progress,
    trend,
    cadence,
    alerts,
    ageMatrix: ageAnalytics?.focusMatrix || null,
    ageMatrixPeriod: ageAnalytics?.periodMatrix || null,
    ageMatrixFocusDate: ageAnalytics?.focusDate || yday,
    backCatalogRatio: ageAnalytics?.backCatalogRatio ?? null,
    backCatalogTargetPct: config.backCatalogTargetPct / 100,
    shortsDecay: ageAnalytics?.shortsDecay || null,
    formatRpm: ageAnalytics?.formatRpm || { shorts: null, videos: null, streams: null },
    monetaryScope: monetaryAvailable,
    ageAnalyticsFetchedAt: ageAnalytics?.fetchedAt || null,
    warnings: [],
  };

  if (!analytics?.ok) {
    northStar.warnings.push(analytics?.message || 'Connect YouTube OAuth for daily views and age matrix.');
  } else if (ageAnalytics == null) {
    northStar.warnings.push('Age matrix not loaded — click Refresh on Channel Stats.');
  } else if (ageAnalytics.ok === false) {
    northStar.warnings.push(ageAnalytics.message || 'Age matrix fetch failed — try Refresh.');
  }

  return northStar;
}

module.exports = {
  SURFACES,
  AGE_BUCKETS,
  parseYmd,
  daysBetween,
  ageBucket,
  emptyAgeMatrix,
  yesterdayYmd,
  computeCadenceFromCatalog,
  cadenceAlerts,
  computeDailyTrend,
  computeProgress,
  aggregateAgeRows,
  buildNorthStarBlock,
};
