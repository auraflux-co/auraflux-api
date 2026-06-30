'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, '../data/test_intelligence_service.db');

describe('intelligence service (CPD-1190)', () => {
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

  it('recordFromPublish writes memory from job spec', () => {
    const intelligence = require('../lib/intelligence');
    const video = intelligence.recordFromPublish(
      {
        jobId: 'script_twitch_999',
        contentType: 'twitch',
        streamers: ['maya'],
        state: {
          savedOutputs: {
            publishCopy: {
              youtube: {
                bestTitle: { title: 'Maya clip goes viral', reason: 'high CTR pattern' },
                tags: ['maya', 'twitch'],
              },
              seo: { primaryKeywords: ['maya clip'] },
            },
          },
        },
      },
      { title: 'Fallback title' },
      {
        platform: 'youtube',
        url: 'https://www.youtube.com/watch?v=abc12345678',
        title: 'Maya clip goes viral',
      },
    );
    assert.ok(video);
    assert.equal(video.jobId, 'script_twitch_999');
    assert.equal(video.streamer, 'maya');
    assert.equal(video.metadata.tags[0], 'maya');

    const decisions = intelligence.memory.listDecisions('script_twitch_999');
    assert.ok(decisions.length >= 1);
  });

  it('recommendContext returns hints when memory is empty', () => {
    const intelligence = require('../lib/intelligence');
    const ctx = intelligence.recommendContext({ contentType: 'twitch', streamer: 'nobody' });
    assert.equal(ctx.ok, true);
    assert.equal(ctx.sampleSize, 0);
    assert.match(ctx.hints[0], /No Content Memory/i);
  });

  it('recommendContext surfaces winning titles from seeded memory', () => {
    const intelligence = require('../lib/intelligence');
    intelligence.memory.upsertVideo({
      platform: 'youtube',
      platformVideoId: 'seedvideo1234',
      jobId: 'script_seed_1',
      contentType: 'twitch',
      streamer: 'ludwig',
      formFactor: 'short',
      title: 'Ludwig reacts hard',
      metadata: { title: 'Ludwig reacts hard', tags: ['ludwig', 'react'] },
      performance: { views: 12000 },
    });
    const ctx = intelligence.recommendContext({
      contentType: 'twitch',
      streamer: 'ludwig',
      formFactor: 'short',
      limit: 3,
    });
    assert.ok(ctx.sampleSize >= 1);
    assert.ok(ctx.winningTitles.includes('Ludwig reacts hard'));
    assert.ok(ctx.topTags.includes('ludwig'));
  });
});
