const fs = require('fs');
const path = require('path');
const { findSlotForCard, enqueueNewsDesk, loadNewsDeskQueue, NEWS_DESK_QUEUE_PATH } = require('../lib/calendar/live_also');

describe('liveAlso', () => {
  const backup = fs.existsSync(NEWS_DESK_QUEUE_PATH) ? fs.readFileSync(NEWS_DESK_QUEUE_PATH, 'utf8') : null;

  afterEach(() => {
    if (backup != null) fs.writeFileSync(NEWS_DESK_QUEUE_PATH, backup);
    else try { fs.unlinkSync(NEWS_DESK_QUEUE_PATH); } catch (_) {}
  });

  test('findSlotForCard matches news_long', () => {
    const slot = findSlotForCard({ contentType: 'news' });
    expect(slot?.id).toBe('news_long');
    expect(slot?.liveAlso).toContain('twitchTv');
  });

  test('enqueueNewsDesk persists queue', () => {
    enqueueNewsDesk({ jobId: 'job-test', videoPath: '/tmp/x.mp4', title: 'News' });
    const q = loadNewsDeskQueue();
    expect(q.items[0].jobId).toBe('job-test');
  });
});
