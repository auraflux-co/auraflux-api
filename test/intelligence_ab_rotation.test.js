'use strict';
/**
 * CPD-1208 — A/B rotation tests. YouTube client injected; DB is the real
 * SQLite (rows cleaned up per test).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');

const HOUR = 3_600_000;

function fakeYt(viewsByCall) {
  const calls = { titleUpdates: [], thumbUpdates: [], statCalls: 0 };
  return {
    calls,
    getVideoStatistics: async () => ({ viewCount: viewsByCall[Math.min(calls.statCalls++, viewsByCall.length - 1)] }),
    updateVideoTitle: async (id, title) => { calls.titleUpdates.push(title); return true; },
    setVideoThumbnail: async (id, p) => { calls.thumbUpdates.push(p); return true; },
  };
}

describe('ab rotation (CPD-1208)', () => {
  let db;

  before(() => {
    db = require('../lib/db').initDb();
  });

  after(() => {
    db.prepare("DELETE FROM content_memory_ab_tests WHERE platform_video_id LIKE 'abtest_%'").run();
    db.prepare("DELETE FROM content_memory_decisions WHERE job_id LIKE 'abtest_%'").run();
  });

  it('evaluate: undecided without enough periods', () => {
    const { evaluate } = require('../lib/intelligence/ab_rotation');
    const periods = [
      { variant: 'a', startedAt: 0, endedAt: 24 * HOUR, startViews: 0, endViews: 500 },
      { variant: 'b', startedAt: 24 * HOUR, endedAt: 48 * HOUR, startViews: 500, endViews: 600 },
    ];
    const v = evaluate(periods);
    assert.equal(v.decided, false);
  });

  it('evaluate: decides a clear winner at 95%', () => {
    const { evaluate } = require('../lib/intelligence/ab_rotation');
    const periods = [
      { variant: 'a', startedAt: 0, endedAt: 24 * HOUR, startViews: 0, endViews: 1000 },
      { variant: 'b', startedAt: 24 * HOUR, endedAt: 48 * HOUR, startViews: 1000, endViews: 1100 },
      { variant: 'a', startedAt: 48 * HOUR, endedAt: 72 * HOUR, startViews: 1100, endViews: 2100 },
      { variant: 'b', startedAt: 72 * HOUR, endedAt: 96 * HOUR, startViews: 2100, endViews: 2220 },
    ];
    const v = evaluate(periods);
    assert.equal(v.decided, true);
    assert.equal(v.winner, 'a');
    assert.ok(Math.abs(v.z) >= 1.96);
  });

  it('evaluate: close rates stay undecided', () => {
    const { evaluate } = require('../lib/intelligence/ab_rotation');
    const periods = [
      { variant: 'a', startedAt: 0, endedAt: 24 * HOUR, startViews: 0, endViews: 100 },
      { variant: 'b', startedAt: 24 * HOUR, endedAt: 48 * HOUR, startViews: 100, endViews: 198 },
      { variant: 'a', startedAt: 48 * HOUR, endedAt: 72 * HOUR, startViews: 198, endViews: 300 },
      { variant: 'b', startedAt: 72 * HOUR, endedAt: 96 * HOUR, startViews: 300, endViews: 401 },
    ];
    const v = evaluate(periods);
    assert.equal(v.decided, false);
  });

  it('startTest opens period on variant a without any API write', async () => {
    const ab = require('../lib/intelligence/ab_rotation');
    const yt = fakeYt([50]);
    const test = await ab.startTest({
      platformVideoId: 'abtest_vid1',
      jobId: 'abtest_job1',
      kind: 'title',
      variantA: { title: 'Original title' },
      variantB: { title: 'Challenger title' },
    }, { yt });
    assert.equal(test.status, 'running');
    assert.equal(test.activeVariant, 'a');
    assert.equal(test.periods.length, 1);
    assert.equal(test.periods[0].startViews, 50);
    assert.equal(yt.calls.titleUpdates.length, 0);
  });

  it('rotateDue flips variant after the period elapses', async () => {
    const ab = require('../lib/intelligence/ab_rotation');
    const yt = fakeYt([100, 300]);
    const start = Date.now() - 25 * HOUR;
    const test = await ab.startTest({
      platformVideoId: 'abtest_vid2',
      jobId: 'abtest_job2',
      kind: 'title',
      variantA: { title: 'A title' },
      variantB: { title: 'B title' },
    }, { yt, now: start });

    const out = await ab.rotateDue({ yt });
    const rotated = out.results.find((r) => r.testId === test.id);
    assert.ok(rotated?.ok);
    assert.equal(rotated.activeVariant, 'b');
    assert.deepEqual(yt.calls.titleUpdates, ['B title']);

    const saved = ab.getTest(test.id);
    assert.equal(saved.periods.length, 2);
    assert.equal(saved.periods[0].endViews, 300);
    assert.equal(saved.periods[1].variant, 'b');
  });

  it('rotateDue completes test and applies winner when significant', async () => {
    const ab = require('../lib/intelligence/ab_rotation');
    const db2 = require('../lib/db').getDb();
    const yt = fakeYt([5000]);
    const now = Date.now();
    // Seed a running test with 4 closed-equivalent periods + 1 due current period.
    const periods = [
      { variant: 'a', startedAt: now - 120 * HOUR, endedAt: now - 96 * HOUR, startViews: 0, endViews: 1000 },
      { variant: 'b', startedAt: now - 96 * HOUR, endedAt: now - 72 * HOUR, startViews: 1000, endViews: 1100 },
      { variant: 'a', startedAt: now - 72 * HOUR, endedAt: now - 48 * HOUR, startViews: 1100, endViews: 2100 },
      { variant: 'b', startedAt: now - 48 * HOUR, endedAt: now - 25 * HOUR, startViews: 2100, endViews: 2220 },
      { variant: 'a', startedAt: now - 25 * HOUR, startViews: 2220 },
    ];
    db2.prepare(`
      INSERT INTO content_memory_ab_tests
        (platform_video_id, job_id, kind, variant_a_json, variant_b_json, active_variant, periods_json, status, created_at, updated_at)
      VALUES ('abtest_vid3', 'abtest_job3', 'title', ?, ?, 'a', ?, 'running', ?, ?)
    `).run(JSON.stringify({ title: 'A wins' }), JSON.stringify({ title: 'B loses' }), JSON.stringify(periods), now, now);

    const out = await ab.rotateDue({ yt });
    const done = out.results.find((r) => r.status === 'complete');
    assert.ok(done, 'expected a completed test');
    assert.equal(done.winner, 'a');
    assert.deepEqual(yt.calls.titleUpdates, ['A wins']);

    const memory = require('../lib/intelligence/memory');
    const decisions = memory.listDecisions('abtest_job3');
    assert.ok(decisions.some((d) => d.kind === 'ab_test_winner'));
  });
});
