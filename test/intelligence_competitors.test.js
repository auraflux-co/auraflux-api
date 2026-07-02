'use strict';
/**
 * CPD-1209 — competitor tracking tests (catalog fetch injected, no network).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

describe('competitor tracking (CPD-1209)', () => {
  let db;

  before(() => {
    db = require('../lib/db').initDb();
    db.prepare("DELETE FROM competitor_videos WHERE video_id LIKE 'comptest_%'").run();
  });

  after(() => {
    db.prepare("DELETE FROM competitor_videos WHERE video_id LIKE 'comptest_%'").run();
  });

  it('syncCompetitors upserts and reports new videos', async () => {
    const competitors = require('../lib/intelligence/competitors');
    const catalog = [
      { videoId: 'comptest_1', title: 'Ron Just Wanted A TV', views: 4_000_000, durationSec: 30, isShort: true },
      { videoId: 'comptest_2', title: 'Normal clip', views: 100_000, durationSec: 25, isShort: true },
    ];
    const out = await competitors.syncCompetitors({
      handles: ['core_fx'],
      fetchCatalog: async () => catalog,
    });
    assert.equal(out.results[0].ok, true);
    assert.equal(out.results[0].new, 2);
    assert.equal(out.newVideos.length, 2);

    // second run: same videos, no new alerts
    const again = await competitors.syncCompetitors({
      handles: ['core_fx'],
      fetchCatalog: async () => catalog,
    });
    assert.equal(again.results[0].new, 0);
    assert.equal(again.newVideos.length, 0);
  });

  it('detectOutliers flags >=3x channel median', async () => {
    const competitors = require('../lib/intelligence/competitors');
    const catalog = [
      { videoId: 'comptest_o1', title: 'MEGA OUTLIER', views: 900_000, durationSec: 30, isShort: true },
      { videoId: 'comptest_o2', title: 'median a', views: 100_000, durationSec: 30, isShort: true },
      { videoId: 'comptest_o3', title: 'median b', views: 110_000, durationSec: 30, isShort: true },
      { videoId: 'comptest_o4', title: 'median c', views: 90_000, durationSec: 30, isShort: true },
    ];
    await competitors.syncCompetitors({
      handles: ['core_fx'],
      fetchCatalog: async () => catalog,
    });
    const outliers = competitors.detectOutliers({ limit: 50 })
      .filter((o) => o.videoId.startsWith('comptest_'));
    assert.ok(outliers.some((o) => o.title === 'MEGA OUTLIER'));
    assert.ok(!outliers.some((o) => o.title === 'median a'));
  });

  it('competitorPatterns emits a prompt block', () => {
    const competitors = require('../lib/intelligence/competitors');
    const block = competitors.competitorPatterns({ limit: 5 });
    assert.ok(block);
    assert.match(block.promptBlock, /Competitor outlier titles/);
    assert.ok(block.outliers.length >= 1);
  });

  it('recommendContext carries competitorPatterns into promptBlock', () => {
    const intelligence = require('../lib/intelligence');
    const ctx = intelligence.recommendContext({ contentType: 'twitch', formFactor: 'short' });
    assert.ok(ctx.competitorPatterns, 'expected competitorPatterns present');
    assert.match(ctx.promptBlock, /Competitor outlier titles/);
  });
});
