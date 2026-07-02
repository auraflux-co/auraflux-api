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
    db.prepare("DELETE FROM competitor_search_log WHERE streamer LIKE 'comptest_%'").run();
  });

  after(() => {
    db.prepare("DELETE FROM competitor_videos WHERE video_id LIKE 'comptest_%'").run();
    db.prepare("DELETE FROM competitor_search_log WHERE streamer LIKE 'comptest_%'").run();
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

  // CPD-1219 — streamer tagging at sync + retag backfill
  it('syncCompetitors tags roster streamers found in titles', async () => {
    const competitors = require('../lib/intelligence/competitors');
    await competitors.syncCompetitors({
      handles: ['core_fx'],
      fetchCatalog: async () => [
        { videoId: 'comptest_tag1', title: 'ExtraEmily LOSES IT on stream', views: 500_000, durationSec: 30, isShort: true },
        { videoId: 'comptest_tag2', title: 'random gameplay moment', views: 50_000, durationSec: 30, isShort: true },
      ],
    });
    const tagged = db.prepare("SELECT streamers FROM competitor_videos WHERE video_id = 'comptest_tag1'").get();
    assert.ok(JSON.parse(tagged.streamers).includes('extraemily'));
    const untagged = db.prepare("SELECT streamers FROM competitor_videos WHERE video_id = 'comptest_tag2'").get();
    assert.deepEqual(JSON.parse(untagged.streamers), []);
  });

  it('retagCompetitorVideos backfills rows with NULL streamers', () => {
    const competitors = require('../lib/intelligence/competitors');
    db.prepare(`
      INSERT INTO competitor_videos (platform, channel_handle, video_id, title, views, duration_sec, is_short, first_seen_at, fetched_at, streamers)
      VALUES ('youtube', 'core_fx', 'comptest_retag1', 'Jason cannot stop laughing', 200000, 30, 1, ?, ?, NULL)
    `).run(Date.now(), Date.now());
    const out = competitors.retagCompetitorVideos();
    assert.ok(out.retagged >= 1);
    const row = db.prepare("SELECT streamers FROM competitor_videos WHERE video_id = 'comptest_retag1'").get();
    assert.ok(JSON.parse(row.streamers).includes('jasontheween'));
  });

  // CPD-1219 phase 2 — YouTube keyword search with daily cache
  it('syncStreamerSearch stores results and serves the daily cache on rerun', async () => {
    const competitors = require('../lib/intelligence/competitors');
    const prevKey = process.env.YOUTUBE_API_KEY;
    process.env.YOUTUBE_API_KEY = 'test-key';
    try {
      let calls = 0;
      const searchVideos = async () => {
        calls += 1;
        return [{ id: 'comptest_yt1', title: 'ExtraEmily viral moment', channelTitle: 'SomeClipChannel', viewCount: 750_000, duration: 40, isShort: true }];
      };
      const first = await competitors.syncStreamerSearch({ streamers: ['comptest_streamer'], searchVideos });
      assert.equal(first.ok, true);
      assert.equal(first.results[0].stored, 1);
      assert.equal(calls, 1);

      const row = db.prepare("SELECT channel_handle, streamers FROM competitor_videos WHERE video_id = 'comptest_yt1'").get();
      assert.equal(row.channel_handle, 'yt-search:SomeClipChannel');
      const tags = JSON.parse(row.streamers);
      assert.ok(tags.includes('comptest_streamer'), 'searched streamer tagged');
      assert.ok(tags.includes('extraemily'), 'title-extracted streamer tagged');

      const second = await competitors.syncStreamerSearch({ streamers: ['comptest_streamer'], searchVideos });
      assert.equal(second.results[0].cached, true);
      assert.equal(calls, 1, 'daily cache should prevent a second API call');
    } finally {
      if (prevKey === undefined) delete process.env.YOUTUBE_API_KEY;
      else process.env.YOUTUBE_API_KEY = prevKey;
    }
  });

  it('syncStreamerSearch skips cleanly without YOUTUBE_API_KEY', async () => {
    const competitors = require('../lib/intelligence/competitors');
    const prevKey = process.env.YOUTUBE_API_KEY;
    delete process.env.YOUTUBE_API_KEY;
    try {
      const out = await competitors.syncStreamerSearch({ streamers: ['comptest_streamer'] });
      assert.equal(out.skipped, true);
    } finally {
      if (prevKey !== undefined) process.env.YOUTUBE_API_KEY = prevKey;
    }
  });
});
