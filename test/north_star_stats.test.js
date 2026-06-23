'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  daysBetween,
  ageBucket,
  computeCadenceFromCatalog,
  cadenceAlerts,
  computeDailyTrend,
  aggregateAgeRows,
  computeProjection,
  buildNorthStarBlock,
} = require('../lib/services/north_star_stats');

test('daysBetween and ageBucket', () => {
  assert.equal(daysBetween('2026-06-22', '2026-06-22'), 0);
  assert.equal(daysBetween('2026-06-23', '2026-06-22'), 1);
  assert.equal(ageBucket(0), 'day1');
  assert.equal(ageBucket(2), 'day3');
  assert.equal(ageBucket(5), 'day4plus');
});

test('computeCadenceFromCatalog counts uploads by surface', () => {
  const items = [
    { id: 'a', tab: 'shorts', published: '2026-06-20' },
    { id: 'b', tab: 'shorts', published: '2026-06-20' },
    { id: 'c', tab: 'videos', published: '2026-06-21' },
    { id: 'd', tab: 'streams', published: '2026-06-21' },
  ];
  const c = computeCadenceFromCatalog(items, 7);
  assert.equal(c.totals.shorts, 2);
  assert.equal(c.totals.videos, 1);
  assert.equal(c.totals.streams, 1);
});

test('cadenceAlerts warns when below minimum', () => {
  const cadence = {
    avgPerDay: { shorts: 1, videos: 0.5, streams: 0 },
  };
  const targets = {
    shorts: { min: 3, max: 5 },
    videos: { min: 1, max: 2 },
    streams: { min: 0, max: 2 },
  };
  const alerts = cadenceAlerts(cadence, targets);
  assert.ok(alerts.some((a) => a.surface === 'shorts' && a.level === 'warn'));
  assert.ok(alerts.some((a) => a.surface === 'videos'));
});

test('computeDailyTrend averages views', () => {
  const trend = computeDailyTrend({
    daily: [
      { day: '2026-06-01', views: 100 },
      { day: '2026-06-02', views: 200 },
    ],
  }, 2);
  assert.equal(trend.avgDailyViews, 150);
  assert.equal(trend.days.length, 2);
});

test('aggregateAgeRows builds matrix and back-catalog ratio', () => {
  const catalog = [
    { id: 'v1', tab: 'shorts', published: '2026-06-20' },
    { id: 'v2', tab: 'videos', published: '2026-06-18' },
  ];
  const rows = [
    { day: '2026-06-20', video: 'v1', views: 100 },
    { day: '2026-06-22', video: 'v2', views: 50 },
    { day: '2026-06-22', video: 'v2', views: 50 },
  ];
  const agg = aggregateAgeRows(rows, catalog, { focusDate: '2026-06-22' });
  assert.equal(agg.totalViews, 200);
  assert.equal(agg.backCatalogRatio, 0.5);
  assert.equal(agg.focusMatrix.videos.day4plus, 100);
});

test('computeProjection uses age matrix views × RPM', () => {
  const projection = computeProjection({
    trend: { avgDailyViews: 290 },
    yesterdayViews: 50,
    ageAnalytics: {
      periodMatrix: {
        shorts: { day1: 1000, day2: 500, day3: 0, day4plus: 0 },
        videos: { day1: 200, day2: 0, day3: 0, day4plus: 0 },
        streams: { day1: 800, day2: 0, day3: 0, day4plus: 0 },
      },
      focusMatrix: {
        shorts: { day1: 10, day2: 0, day3: 0, day4plus: 0 },
        videos: { day1: 0, day2: 0, day3: 0, day4plus: 0 },
        streams: { day1: 40, day2: 0, day3: 0, day4plus: 0 },
      },
    },
    catalog: {},
    config: {
      projectionEnabled: true,
      dailyUsdTarget: 300,
      analyticsWindowDays: 28,
      projectedRpm: { shorts: 0.03, videos: 3.5, streams: 2 },
    },
  });
  assert.ok(projection);
  assert.equal(projection.source, 'age_matrix');
  assert.ok(projection.avgDailyUsd > 0);
  assert.ok(projection.yesterdayUsd > 0);
  assert.ok(projection.viewsNeededForTarget > 0);
});

test('buildNorthStarBlock uses projected mode pre-YPP', () => {
  const block = buildNorthStarBlock({
    catalog: {
      items: [{ id: 'x', tab: 'shorts', published: '2026-06-22' }],
      byTab: { shorts: { views: 1000 }, videos: { views: 200 }, streams: { views: 800 } },
    },
    analytics: {
      ok: true,
      channelSummary: {
        daily: [{ day: '2026-06-22', views: 500, estimatedRevenue: 0 }],
      },
    },
    ageAnalytics: {
      ok: true,
      periodMatrix: {
        shorts: { day1: 1000, day2: 0, day3: 0, day4plus: 0 },
        videos: { day1: 100, day2: 0, day3: 0, day4plus: 0 },
        streams: { day1: 500, day2: 0, day3: 0, day4plus: 0 },
      },
      focusMatrix: {
        shorts: { day1: 10, day2: 0, day3: 0, day4plus: 0 },
        videos: { day1: 0, day2: 0, day3: 0, day4plus: 0 },
        streams: { day1: 40, day2: 0, day3: 0, day4plus: 0 },
      },
      backCatalogRatio: 0.1,
      shortsDecay: { d1: 5, d2: 2, d3: 0, d4: 0, d5: 0, d6: 0, d7: 0 },
      formatRpm: { shorts: null, videos: null, streams: null },
      hasRevenue: false,
    },
    config: {
      dailyUsdTarget: 300,
      viewsProxyPerDay: 100000,
      analyticsWindowDays: 28,
      ageMatrixDays: 28,
      projectionEnabled: true,
      projectedRpm: { shorts: 0.03, videos: 3.5, streams: 2 },
      cadence: {
        shorts: { min: 3, max: 5 },
        videos: { min: 1, max: 2 },
        streams: { min: 0, max: 2 },
      },
      backCatalogTargetPct: 30,
    },
  });
  assert.equal(block.isMonetized, false);
  assert.equal(block.progress.mode, 'projected');
  assert.ok(block.progress.avgDailyUsd > 0);
  assert.ok(block.projection);
});
