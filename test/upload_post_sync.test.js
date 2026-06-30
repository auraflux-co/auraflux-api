'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  historyRowToCalendarItem,
  dedupeUploadPostItems,
  buildJobLinkIndex,
} = require('../lib/calendar/upload_post_sync');

describe('upload_post_sync', () => {
  it('historyRowToCalendarItem uses upload_timestamp as publish time', () => {
    const index = buildJobLinkIndex({});
    const item = historyRowToCalendarItem({
      platform: 'tiktok',
      success: true,
      upload_timestamp: '2026-06-26T19:15:56.331Z',
      post_title: 'Test TikTok\n\nextra',
      job_id: 'abc123',
    }, index, '2026-06-01', '2026-06-30', {});
    assert.ok(item);
    assert.equal(item.platform, 'tiktok');
    assert.equal(item.status, 'published');
    assert.equal(item.publishAt, '2026-06-26T19:15:56.331Z');
    assert.equal(item.dateKey, '2026-06-26');
    assert.match(item.timeEt, /\d/);
  });

  it('dedupeUploadPostItems prefers published over scheduled for same job', () => {
    const out = dedupeUploadPostItems([
      {
        platform: 'instagram',
        uploadPostJobId: 'job1',
        title: 'A',
        publishAt: '2026-06-30T21:00:00.000Z',
        status: 'scheduled',
      },
      {
        platform: 'instagram',
        uploadPostJobId: 'job1',
        title: 'A',
        publishAt: '2026-06-30T19:00:00.000Z',
        status: 'published',
      },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, 'published');
    assert.equal(out[0].publishAt, '2026-06-30T19:00:00.000Z');
  });

  it('buildJobLinkIndex links gate5 platform job ids', () => {
    const index = buildJobLinkIndex({
      job_x: {
        gate5Result: {
          platforms: {
            tiktok: { jobId: 'up_job_99' },
          },
        },
      },
    });
    assert.deepEqual(index.byPlatformJobId.get('up_job_99'), {
      jobId: 'job_x',
      platform: 'tiktok',
    });
  });
});
