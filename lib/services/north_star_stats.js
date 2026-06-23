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

function sumMatrixViews(matrix) {
  const out = { shorts: 0, videos: 0, streams: 0 };
  if (!matrix) return out;
  for (const s of SURFACES) {
    const row = matrix[s] || {};
    out[s] = (row.day1 || 0) + (row.day2 || 0) + (row.day3 || 0) + (row.day4plus || 0);
  }
  return out;
}

function revenueFromViews(viewsBySurface, rpmBySurface) {
  let usd = 0;
  const breakdown = {};
  for (const s of SURFACES) {
    const views = viewsBySurface[s] || 0;
    const rpm = rpmBySurface[s] || 0;
    const rev = (views / 1000) * rpm;
    breakdown[s] = { views, rpm, usd: Math.round(rev * 100) / 100 };
    usd += rev;
  }
  return { usd: Math.round(usd * 100) / 100, breakdown };
}

function viewsShareFromCatalog(catalog) {
  const byTab = catalog?.byTab || {};
  let total = 0;
  const views = {};
  for (const s of SURFACES) {
    views[s] = byTab[s]?.views || 0;
    total += views[s];
  }
  if (!total) {
    return { shorts: 0.42, videos: 0.1, streams: 0.48 };
  }
  const share = {};
  for (const s of SURFACES) share[s] = views[s] / total;
  return share;
}

function computeProjection({ trend, yesterdayViews, ageAnalytics, catalog, config, reportingRange }) {
  if (!config.projectionEnabled) return null;
  const rpm = config.projectedRpm;
  const windowDays = reportingRange?.days || config.analyticsWindowDays;
  const periodViews = sumMatrixViews(ageAnalytics?.periodMatrix);
  const periodTotal = SURFACES.reduce((n, s) => n + periodViews[s], 0);

  if (periodTotal > 0) {
    const period = revenueFromViews(periodViews, rpm);
    const focusViews = sumMatrixViews(ageAnalytics?.focusMatrix);
    const yday = revenueFromViews(focusViews, rpm);
    const blendedRpm = Math.round((period.usd / periodTotal) * 1000 * 100) / 100;
    return {
      source: 'age_matrix',
      avgDailyUsd: Math.round((period.usd / windowDays) * 100) / 100,
      yesterdayUsd: yday.usd,
      periodUsd: period.usd,
      blendedRpm,
      breakdown: period.breakdown,
      projectedRpm: rpm,
      viewsNeededForTarget: blendedRpm > 0
        ? Math.round((config.dailyUsdTarget / blendedRpm) * 1000)
        : null,
    };
  }

  if (trend.avgDailyViews > 0) {
    const share = viewsShareFromCatalog(catalog);
    const blendedRpm = SURFACES.reduce((n, s) => n + (share[s] || 0) * (rpm[s] || 0), 0);
    const avgDailyUsd = Math.round((trend.avgDailyViews / 1000) * blendedRpm * 100) / 100;
    const yesterdayUsd = yesterdayViews != null
      ? Math.round((yesterdayViews / 1000) * blendedRpm * 100) / 100
      : null;
    return {
      source: 'catalog_mix',
      avgDailyUsd,
      yesterdayUsd,
      blendedRpm: Math.round(blendedRpm * 100) / 100,
      projectedRpm: rpm,
      surfaceShare: share,
      viewsNeededForTarget: blendedRpm > 0
        ? Math.round((config.dailyUsdTarget / blendedRpm) * 1000)
        : null,
    };
  }

  return null;
}

function computeCadenceFromCatalog(items, windowDays = 7, endDate, focusDate) {
  const today = endDate || new Date().toISOString().slice(0, 10);
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

  const focus = focusDate || ymdAddDays(today, -1);
  const yesterday = byDay[focus] || { shorts: 0, videos: 0, streams: 0 };

  return { windowDays, start, end: today, focusDate: focus, byDay, yesterday, totals, avgPerDay, daysWithData };
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

function computeDailyTrend(channelSummary, range = {}) {
  const rows = channelSummary?.daily || [];
  if (!rows.length) return { days: [], totals: null, avgDailyViews: 0, avgDailyRevenue: null };

  const start = range.startDate;
  const end = range.endDate;
  const slice = rows.filter((r) => {
    if (start && r.day < start) return false;
    if (end && r.day > end) return false;
    return true;
  });
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

function computeProgress({ trend, yesterdayViews, yesterdayRevenue, config, isMonetized, projection }) {
  const target = config.dailyUsdTarget;
  let mode = 'views_proxy';
  let pctOfTarget = 0;
  let avgDailyUsd = null;
  let yesterdayUsd = null;
  let viewsNeededForTarget = config.viewsProxyPerDay;

  if (isMonetized && trend.avgDailyRevenue != null) {
    mode = 'revenue';
    avgDailyUsd = trend.avgDailyRevenue;
    yesterdayUsd = yesterdayRevenue;
    pctOfTarget = target > 0 ? Math.min(100, (avgDailyUsd / target) * 100) : 0;
  } else if (projection) {
    mode = 'projected';
    avgDailyUsd = projection.avgDailyUsd;
    yesterdayUsd = projection.yesterdayUsd;
    pctOfTarget = target > 0 && avgDailyUsd != null ? Math.min(100, (avgDailyUsd / target) * 100) : 0;
    if (projection.viewsNeededForTarget) viewsNeededForTarget = projection.viewsNeededForTarget;
  } else {
    pctOfTarget = viewsNeededForTarget > 0 ? Math.min(100, (trend.avgDailyViews / viewsNeededForTarget) * 100) : 0;
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
    viewsNeededForTarget,
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

function buildNorthStarBlock({ catalog, analytics, ageAnalytics, config: cfgIn, reportingRange }) {
  const config = cfgIn || getNorthStarConfig();
  const items = catalog?.items || [];
  const range = reportingRange || {
    startDate: null,
    endDate: null,
    days: config.analyticsWindowDays,
    focusDate: yesterdayYmd(),
  };
  const windowDays = range.days || config.analyticsWindowDays;

  let channelSummary = analytics?.channelSummary;
  if (analytics?.ok && !channelSummary) {
    channelSummary = { daily: [], totals: {} };
  }

  const trend = computeDailyTrend(channelSummary, range);
  const cadence = computeCadenceFromCatalog(items, 7, range.endDate, range.focusDate);
  const alerts = cadenceAlerts(cadence, config.cadence);

  const focusDay = range.focusDate || yesterdayYmd();
  const focusRow = (channelSummary?.daily || []).find((r) => r.day === focusDay);
  const yesterdayViews = focusRow?.views ?? null;
  const yesterdayRevenue = focusRow?.estimatedRevenue ?? null;

  const isMonetized = !!(ageAnalytics?.hasRevenue || trend.days.some((d) => (d.estimatedRevenue || 0) > 0));
  const projection = !isMonetized
    ? computeProjection({ trend, yesterdayViews, ageAnalytics, catalog, config, reportingRange: range })
    : null;

  const progress = computeProgress({
    trend,
    yesterdayViews,
    yesterdayRevenue,
    config,
    isMonetized,
    projection,
  });

  const formatRpmActual = ageAnalytics?.formatRpm || { shorts: null, videos: null, streams: null };
  const formatRpmDisplay = isMonetized ? formatRpmActual : config.projectedRpm;

  const northStar = {
    config: {
      dailyUsdTarget: config.dailyUsdTarget,
      cadence: config.cadence,
      backCatalogTargetPct: config.backCatalogTargetPct,
      windowDays,
      projectedRpm: config.projectedRpm,
    },
    reportingRange: range,
    isMonetized,
    projection,
    progress,
    trend,
    cadence,
    alerts,
    ageMatrix: ageAnalytics?.focusMatrix || null,
    ageMatrixPeriod: ageAnalytics?.periodMatrix || null,
    ageMatrixFocusDate: ageAnalytics?.focusDate || focusDay,
    backCatalogRatio: ageAnalytics?.backCatalogRatio ?? null,
    backCatalogTargetPct: config.backCatalogTargetPct / 100,
    shortsDecay: ageAnalytics?.shortsDecay || null,
    formatRpm: formatRpmDisplay,
    formatRpmActual,
    ageAnalyticsFetchedAt: ageAnalytics?.fetchedAt || null,
    warnings: [],
  };

  if (!analytics?.ok) {
    northStar.warnings.push(analytics?.message || 'Connect YouTube OAuth for daily views and age matrix.');
  } else if (ageAnalytics == null && analytics?.ok && !projection) {
    northStar.warnings.push('Age matrix not loaded yet — click Refresh (takes ~30s).');
  } else if (ageAnalytics && ageAnalytics.ok === false) {
    northStar.warnings.push(ageAnalytics.message || 'Age matrix fetch failed — try Refresh.');
  } else if (!isMonetized && projection) {
    northStar.warnings.push(
      'Pre-YPP projection: $ = assumed RPM × your Analytics views (Shorts $'
      + config.projectedRpm.shorts + ', VOD $' + config.projectedRpm.videos + ', Lives $'
      + config.projectedRpm.streams + '/1k) — not YouTube payouts.',
    );
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
  sumMatrixViews,
  revenueFromViews,
  computeProjection,
  yesterdayYmd,
  ymdAddDays,
  computeCadenceFromCatalog,
  cadenceAlerts,
  computeDailyTrend,
  computeProgress,
  aggregateAgeRows,
  buildNorthStarBlock,
};
