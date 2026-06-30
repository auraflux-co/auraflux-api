'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, '../data/test_intelligence_phase2.db');

describe('intelligence phases 2–4 (CPD-1194–1196)', () => {
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

  it('prompt_blocks formats recommend context', () => {
    const { formatRecommendPromptBlock } = require('../lib/intelligence/prompt_blocks');
    const block = formatRecommendPromptBlock({
      sampleSize: 2,
      avgViews: 5000,
      winningTitles: ['ExtraEmily reacts hard'],
      topTags: ['twitch', 'clip'],
    });
    assert.match(block, /Historical performance/);
    assert.match(block, /ExtraEmily reacts hard/);
  });

  it('getPublishIntelligenceContext merges keywords', () => {
    const intelligence = require('../lib/intelligence');
    const block = intelligence.getPublishIntelligenceContext({
      contentType: 'twitch',
      streamer: 'maya',
      formFactor: 'short',
      publishCopy: {
        seo: { primaryKeywords: ['maya clip'] },
        youtube: { tags: ['twitch'] },
      },
    });
    assert.ok(block.intelligenceContext);
    assert.ok(Array.isArray(block.keywordBlock.keywords));
    assert.ok(block.promptBlock.length > 0);
  });

  it('recordPublishGenerationDecisions writes audit rows', () => {
    const intelligence = require('../lib/intelligence');
    intelligence.recordPublishGenerationDecisions('script_test_pc', {
      youtube: { bestTitle: { title: 'Test Title', reason: 'high CTR' } },
    }, { sampleSize: 3, avgViews: 100, hints: ['matched'] });
    const rows = intelligence.memory.listDecisions('script_test_pc');
    assert.ok(rows.some((r) => r.kind === 'publish_title_generated'));
    assert.ok(rows.some((r) => r.kind === 'intelligence_context_used'));
  });

  it('reconcileOutcomes attaches performance to decisions', () => {
    const intelligence = require('../lib/intelligence');
    intelligence.memory.upsertVideo({
      platform: 'youtube',
      platformVideoId: 'reconcile12345',
      jobId: 'script_reconcile_1',
      performance: { views: 9000, averageViewPercentage: 0.42 },
      syncedAt: Date.now(),
    });
    intelligence.recordDecision({
      jobId: 'script_reconcile_1',
      kind: 'publish_title',
      choice: { title: 'Winner' },
      reasons: ['test'],
    });
    const result = intelligence.reconcileOutcomes();
    assert.ok(result.updated >= 1);
    const decisions = intelligence.memory.listDecisions('script_reconcile_1');
    assert.ok(decisions[0].outcome?.views === 9000);
  });

  it('backfillFromJobs seeds from mock jobs file', () => {
    const intelligence = require('../lib/intelligence');
    const jobsFile = path.join(__dirname, '../data/test_intel_backfill_jobs.json');
    fs.writeFileSync(jobsFile, JSON.stringify({
      script_backfill_1: {
        stage: 'published',
        contentType: 'twitch',
        streamers: ['ludwig'],
        publishRecord: { youtubeUrl: 'https://www.youtube.com/watch?v=backfill1234' },
        title: 'Backfill test',
        publishCopy: { youtube: { bestTitle: { title: 'Backfill test' }, tags: ['ludwig'] } },
      },
    }));
    const result = intelligence.backfillFromJobs({ limit: 10, jobsFile });
    assert.equal(result.scanned, 1);
    assert.equal(result.results[0].ok, true);
    fs.unlinkSync(jobsFile);
  });
});
