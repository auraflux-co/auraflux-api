const {
  videoToCalendarItem,
  videoEffectivePublishAt,
  formatTimeEt,
} = require('../lib/calendar/youtube_studio_sync');

describe('youtube calendar items', () => {
  test('videoEffectivePublishAt uses scheduled when only publishAt set', () => {
    const video = {
      status: { publishAt: '2026-12-30T21:00:00.000Z', privacyStatus: 'private' },
      snippet: { title: 'Future' },
    };
    expect(videoEffectivePublishAt(video)).toBe('2026-12-30T21:00:00.000Z');
  });

  test('videoToCalendarItem includes timeEt in range', () => {
    const item = videoToCalendarItem({
      id: 'abc12345678',
      status: { publishAt: '2026-06-30T21:00:00.000Z', privacyStatus: 'private' },
      snippet: { title: 'Test Short #Shorts' },
      contentDetails: { duration: 'PT45S' },
    }, '2026-06-30', '2026-06-30');
    expect(item).toBeTruthy();
    expect(item.dateKey).toBe('2026-06-30');
    expect(item.timeEt).toBeTruthy();
    expect(item.publishAt).toBe('2026-06-30T21:00:00.000Z');
    expect(typeof formatTimeEt(item.publishAt)).toBe('string');
  });

  test('videoToCalendarItem excludes out-of-range dates', () => {
    const item = videoToCalendarItem({
      id: 'xyz98765432',
      status: { privacyStatus: 'public' },
      snippet: { title: 'Old', publishedAt: '2026-05-01T12:00:00.000Z' },
      contentDetails: { duration: 'PT10M' },
    }, '2026-06-01', '2026-06-30');
    expect(item).toBeNull();
  });
});
