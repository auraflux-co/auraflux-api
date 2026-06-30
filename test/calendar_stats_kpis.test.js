const { buildCalendarStatsKpis } = require('../lib/calendar/calendar_stats_kpis');

describe('calendar_stats_kpis', () => {
  test('aggregates views by format from matched catalog rows', () => {
    const kpis = buildCalendarStatsKpis({
      calendarItems: [
        { jobId: 'j1', format: 'short', youtubeVideoId: 'aaa11111111', title: 'Short A', status: 'published' },
        { jobId: 'j2', format: 'longform', youtubeVideoId: 'bbb22222222', title: 'VOD B', status: 'published' },
      ],
      catalogItems: [
        { video_id: 'aaa11111111', tab: 'shorts', views: 5000, analytics: { views: 5000, engagedViews: 4000 } },
        { video_id: 'bbb22222222', tab: 'videos', views: 12000, analytics: { views: 12000, subscribersGained: 3 } },
      ],
    });
    expect(kpis.matchedCount).toBe(2);
    expect(kpis.byFormat.short.views).toBe(5000);
    expect(kpis.byFormat.longform.views).toBe(12000);
    expect(kpis.totalViews).toBe(17000);
    expect(kpis.rows[0].views).toBeGreaterThan(0);
  });

  test('reports unmatched calendar items without views', () => {
    const kpis = buildCalendarStatsKpis({
      calendarItems: [{ jobId: 'j3', format: 'short', title: 'No YT yet', status: 'scheduled' }],
      catalogItems: [],
    });
    expect(kpis.unmatchedCount).toBe(1);
    expect(kpis.totalViews).toBe(0);
    expect(kpis.rows[0].matched).toBe(false);
  });
});
