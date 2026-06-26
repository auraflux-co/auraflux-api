'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, '../data/test_content_library.db');

describe('content_library store', () => {
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

  it('upserts and lists clips', () => {
    const { upsertLibraryClip, listLibraryClips } = require('../lib/content_library/store');
    const now = Date.now();
    upsertLibraryClip({
      platform: 'twitch',
      streamer: 'cinna',
      clip_id: 'TestClip123',
      url: 'https://clips.twitch.tv/TestClip123',
      title: 'Test',
      views: 100,
      duration_sec: 30,
      clip_created_at: now - 3600000,
      ingest_date: '2026-06-25',
      expires_at: now + 86400000,
    });
    const rows = listLibraryClips({ streamers: ['cinna'], window: '24h' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].clip_id, 'TestClip123');
  });

  it('purge skips used clips', () => {
    const { upsertLibraryClip, markClipsUsedForJob, purgeEligibleClips } = require('../lib/content_library/store');
    const past = Date.now() - 86400000 * 8;
    upsertLibraryClip({
      platform: 'twitch',
      streamer: 'maya',
      clip_id: 'OldUnused',
      url: 'https://clips.twitch.tv/OldUnused',
      expires_at: past,
    });
    upsertLibraryClip({
      platform: 'twitch',
      streamer: 'maya',
      clip_id: 'OldUsed',
      url: 'https://clips.twitch.tv/OldUsed',
      used_at: Date.now(),
      job_id: 'script_test_1',
      expires_at: null,
    });
    const result = purgeEligibleClips(Date.now(), { dryRun: false });
    assert.ok(result.deleted >= 1);
    const { listLibraryClips } = require('../lib/content_library/store');
    const remain = listLibraryClips({ streamers: ['maya'], window: 'all' });
    assert.ok(remain.some((r) => r.clip_id === 'OldUsed'));
    assert.ok(!remain.some((r) => r.clip_id === 'OldUnused'));
  });
});
