'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('publish_dedupe', () => {
  const {
    isDriveUrlAlreadyPublished,
    needsRepublish,
    resolveCardDriveUrl,
  } = require('../lib/publish_dedupe');

  it('resolveCardDriveUrl prefers savedOutputs', () => {
    const url = resolveCardDriveUrl({
      driveUrl: 'https://old.example/a.mp4',
      state: { savedOutputs: { driveUrl: 'https://new.example/b.mp4' } },
    });
    assert.equal(url, 'https://new.example/b.mp4');
  });

  it('needsRepublish when card driveUrl differs from published rows', () => {
    const db = require('../lib/db');
    const orig = db.getPublishedResults;
    db.getPublishedResults = () => [{
      platform_job_id: 'abc',
      drive_url: 'https://assets.example/outputs/job/old_cut.mp4',
    }];
    try {
      const card = {
        jobId: 'job1',
        driveUrl: 'https://assets.example/outputs/job/new_cut.mp4',
        state: { savedOutputs: { driveUrl: 'https://assets.example/outputs/job/new_cut.mp4' } },
      };
      assert.equal(needsRepublish(card, 'job1'), true);
      assert.equal(
        isDriveUrlAlreadyPublished('job1', 'https://assets.example/outputs/job/old_cut.mp4'),
        true,
      );
      assert.equal(
        isDriveUrlAlreadyPublished('job1', 'https://assets.example/outputs/job/new_cut.mp4'),
        false,
      );
    } finally {
      db.getPublishedResults = orig;
    }
  });
});
