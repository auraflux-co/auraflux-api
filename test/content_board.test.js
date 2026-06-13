const { buildContentBoard, buildTodaySchedule } = require('../lib/broadcast/content_board');

describe('content_board', () => {
  test('today schedule includes daily news', () => {
    const s = buildTodaySchedule(new Date('2026-06-13T15:00:00-04:00'));
    expect(s.items.some(i => i.kind === 'news')).toBe(true);
    expect(s.isTwitchLongDay).toBe(true); // Saturday
  });

  test('flags news gap when no pipeline and stale files only', () => {
    const board = buildContentBoard({
      persistedJobs: {
        script_twitch_1: { contentType: 'twitch', stage: 'avatar_in_progress', date: 'Saturday, June 13, 2026' },
      },
    });
    expect(board.ok).toBe(true);
    expect(board.pipeline.length).toBeGreaterThan(0);
    const newsSlot = board.scheduled.find(s => s.kind === 'news');
    expect(newsSlot.status).toMatch(/stale|gap/);
  });
});
