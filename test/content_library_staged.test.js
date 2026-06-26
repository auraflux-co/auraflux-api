'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, '../data/test_staged_library.db');

describe('library staged clips', () => {
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

  it('upserts staged clip and marks used', () => {
    const { upsertStagedClip, getStagedClipByUrl, markStagedClipsUsedForJob } = require('../lib/content_library/staged_store');
    const url = 'https://clips.twitch.tv/StageClip1';
    upsertStagedClip({
      platform: 'twitch',
      streamer: 'cinna',
      clip_id: 'StageClip1',
      url,
      title: 'Stage test',
      duration_sec: 42,
      r2_key: 'library-staging/cinna/StageClip1.mp4',
      r2_url: 'https://cdn.example.com/library-staging/cinna/StageClip1.mp4',
      staged_at: Date.now(),
      expires_at: Date.now() + 86400000,
      status: 'ready',
    });
    const row = getStagedClipByUrl(url);
    assert.equal(row.clip_id, 'StageClip1');
    assert.equal(row.r2_url.includes('StageClip1.mp4'), true);
    markStagedClipsUsedForJob('job_1', [url]);
    const used = getStagedClipByUrl(url);
    assert.ok(used.used_at);
    assert.equal(used.job_id, 'job_1');
  });

  it('lists eligible R2 purge rows', () => {
    const { upsertStagedClip, listStagedClipsEligibleForPurge } = require('../lib/content_library/staged_store');
    upsertStagedClip({
      platform: 'twitch',
      streamer: 'maya',
      clip_id: 'ExpiredStage',
      url: 'https://clips.twitch.tv/ExpiredStage',
      r2_key: 'library-staging/maya/ExpiredStage.mp4',
      r2_url: 'https://cdn.example.com/library-staging/maya/ExpiredStage.mp4',
      staged_at: Date.now() - 86400000 * 8,
      expires_at: Date.now() - 1000,
      status: 'ready',
    });
    const rows = listStagedClipsEligibleForPurge(Date.now());
    assert.ok(rows.some((r) => r.clip_id === 'ExpiredStage'));
  });
});

describe('stagingExpiresAtMs', () => {
  it('returns a future Sunday EOW ET timestamp', () => {
    const { stagingExpiresAtMs } = require('../lib/content_library/time_et');
    const exp = stagingExpiresAtMs(new Date('2026-06-25T15:00:00Z'));
    assert.ok(exp > Date.now());
  });
});
