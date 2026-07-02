'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadModule(counterFile) {
  process.env.EPISODE_COUNTERS_PATH = counterFile;
  delete require.cache[require.resolve('../lib/episode_counters')];
  return require('../lib/episode_counters');
}

describe('episode_counters', () => {
  it('maps content types to counter keys', () => {
    const mod = loadModule(path.join(os.tmpdir(), 'ep-key-test.json'));
    assert.strictEqual(mod.counterKey('twitch'), 'twitch');
    assert.strictEqual(mod.counterKey('twitch-short'), 'twitch-short_short');
    assert.strictEqual(mod.baseContentType('twitch-long'), 'twitch');
  });

  it('increments long-form counter after publish', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ep-inc-')), 'counters.json');
    fs.writeFileSync(file, JSON.stringify({ twitch: 4, nba: 1, news: 1 }));
    const mod = loadModule(file);
    const result = mod.incrementAfterPublish({
      jobId: 'job-1',
      contentType: 'twitch',
      jobSpec: { contentType: 'twitch', state: { savedOutputs: { episodeNumber: 'Episode 4' } } },
    });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.publishedNum, 4);
    assert.strictEqual(result.next, 5);
    assert.strictEqual(mod.readCounters().twitch, 5);
  });

  it('skips shorts and idempotent republish', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ep-skip-')), 'counters.json');
    fs.writeFileSync(file, JSON.stringify({ twitch: 2 }));
    const mod = loadModule(file);
    const skippedShort = mod.incrementAfterPublish({
      jobId: 's-1',
      contentType: 'twitch-short',
      jobSpec: { contentType: 'twitch-short', isShort: true },
    });
    assert.strictEqual(skippedShort.skipped, true);
    assert.strictEqual(mod.readCounters().twitch, 2);

    const skippedAgain = mod.incrementAfterPublish({
      jobId: 'job-2',
      contentType: 'twitch',
      jobSpec: { contentType: 'twitch' },
      alreadyIncremented: true,
    });
    assert.strictEqual(skippedAgain.skipped, true);
    assert.strictEqual(mod.readCounters().twitch, 2);
  });
});
