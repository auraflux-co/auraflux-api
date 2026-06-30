'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, '../data/test_intelligence_memory.db');

describe('intelligence memory (CPD-1191)', () => {
  before(() => {
    process.env.CWN_DB_PATH = TEST_DB;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    require('../lib/db').initDb();
  });

  after(() => {
    require('../lib/db').closeDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    delete process.env.CWN_DB_PATH;
  });

  it('upserts and retrieves a video', () => {
    const { upsertVideo, getVideo, memoryStats } = require('../lib/intelligence/memory');
    const v = upsertVideo({
      platform: 'youtube',
      platformVideoId: 'dQw4w9WgXcQ',
      jobId: 'script_test_1',
      title: 'Test Video',
      contentType: 'twitch',
      streamer: 'hasanabi',
      formFactor: 'short',
      metadata: { tags: ['gaming', 'clip'] },
      performance: { views: 1000 },
    });
    assert.equal(v.platformVideoId, 'dQw4w9WgXcQ');
    assert.equal(v.jobId, 'script_test_1');
    assert.equal(v.performance.views, 1000);

    const again = getVideo('youtube', 'dQw4w9WgXcQ');
    assert.equal(again.title, 'Test Video');

    const stats = memoryStats();
    assert.equal(stats.total, 1);
    assert.equal(stats.pendingSync, 1);
  });

  it('records decisions and lists by job', () => {
    const { recordDecision, listDecisions } = require('../lib/intelligence/memory');
    recordDecision({
      jobId: 'script_test_1',
      kind: 'publish_title',
      choice: { title: 'Winning title' },
      reasons: ['best_title_score'],
    });
    const rows = listDecisions('script_test_1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'publish_title');
    assert.equal(rows[0].choice.title, 'Winning title');
  });

  it('topPerformers ranks by views', () => {
    const { upsertVideo, topPerformers } = require('../lib/intelligence/memory');
    upsertVideo({
      platform: 'youtube',
      platformVideoId: 'lowviews12345',
      performance: { views: 50 },
      contentType: 'twitch',
    });
    upsertVideo({
      platform: 'youtube',
      platformVideoId: 'highviews1234',
      performance: { views: 5000 },
      contentType: 'twitch',
    });
    const top = topPerformers({ metric: 'views', contentType: 'twitch', limit: 2 });
    assert.equal(top.length, 2);
    assert.equal(top[0].platformVideoId, 'highviews1234');
  });
});
