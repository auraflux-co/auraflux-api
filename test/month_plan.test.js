const { buildMonthPlan, setDayPlan, setMonthDefaultTargets, buildCalendarRangeReport } = require('../lib/calendar/month_plan');
const { classifyJobCard, classifyYoutubeItem } = require('../lib/calendar/content_taxonomy');

describe('content_taxonomy', () => {
  test('classifies twitch short comp', () => {
    expect(classifyJobCard({ contentType: 'twitch-short', clipsOnly: true })).toEqual({
      format: 'short',
      pillar: 'twitch',
      contentType: 'twitch-short',
    });
  });

  test('classifies news longform', () => {
    expect(classifyJobCard({ contentType: 'news' })).toEqual({
      format: 'longform',
      pillar: 'news',
      contentType: 'news',
    });
  });
});

describe('month_plan', () => {
  test('buildMonthPlan returns days for June 2026', () => {
    const plan = buildMonthPlan({
      year: 2026,
      month: 6,
      persistedJobs: {},
      youtubeItems: [],
    });
    expect(plan.ok).toBe(true);
    expect(plan.days.length).toBe(30);
    expect(plan.days[0].date).toBe('2026-06-01');
    const june30 = plan.days.find((d) => d.date === '2026-06-30');
    expect(june30.planned.short).toBe(3);
    expect(june30.planned.longform).toBe(1);
  });

  test('counts scheduled job on correct day', () => {
    const plan = buildMonthPlan({
      year: 2026,
      month: 6,
      persistedJobs: {
        job_a: {
          contentType: 'twitch-short',
          clipsOnly: true,
          stage: 'publish_scheduled',
          scheduledPublishAt: '2026-06-30T21:00:00.000Z',
          title: 'funnymike short',
        },
      },
      youtubeItems: [],
    });
    const june30 = plan.days.find((d) => d.date === '2026-06-30');
    expect(june30.actual.counts.short).toBeGreaterThanOrEqual(1);
    expect(june30.actual.items.some((it) => it.jobId === 'job_a')).toBe(true);
  });

  test('setDayPlan persists custom day', () => {
    const result = setDayPlan({
      year: 2026,
      month: 7,
      dateKey: '2026-07-04',
      targets: { short: 5, longform: 2, live: 1 },
      note: 'Holiday push',
    });
    expect(result.ok).toBe(true);
    const plan = buildMonthPlan({ year: 2026, month: 7, persistedJobs: {}, youtubeItems: [] });
    const july4 = plan.days.find((d) => d.date === '2026-07-04');
    expect(july4.planned.short).toBe(5);
    expect(july4.planned.note).toBe('Holiday push');
  });

  test('YouTube publish time wins over job Gate 5 timestamp', () => {
    const plan = buildMonthPlan({
      year: 2026,
      month: 6,
      persistedJobs: {
        job_a: {
          contentType: 'twitch-short',
          clipsOnly: true,
          stage: 'published',
          publishedAt: '2026-06-30T14:00:00.000Z',
          scheduledPublishAt: '2026-06-30T21:00:00.000Z',
          youtubeVideoId: 'abc123vid01',
          title: 'test short',
        },
      },
      youtubeItems: [{
        source: 'youtube_studio',
        videoId: 'abc123vid01',
        jobId: 'job_a',
        title: 'test short',
        publishAt: '2026-06-30T17:00:00.000Z',
        dateKey: '2026-06-30',
        timeEt: '1:00 PM',
        kind: 'short',
        status: 'published',
      }],
    });
    const june30 = plan.days.find((d) => d.date === '2026-06-30');
    expect(june30.actual.items.length).toBe(1);
    expect(june30.actual.items[0].timeEt).toBe('1:00 PM');
    expect(june30.actual.items[0].platform).toBe('youtube');
  });

  test('Upload-Post items appear with platform publish time', () => {
    const plan = buildMonthPlan({
      year: 2026,
      month: 6,
      persistedJobs: {},
      youtubeItems: [],
      uploadPostItems: [{
        source: 'upload_post_tiktok',
        platform: 'tiktok',
        title: 'TikTok clip',
        publishAt: '2026-06-26T19:15:56.331Z',
        dateKey: '2026-06-26',
        timeEt: '3:15 PM',
        status: 'published',
        format: 'short',
      }],
    });
    const day = plan.days.find((d) => d.date === '2026-06-26');
    expect(day.actual.items.some((it) => it.platform === 'tiktok')).toBe(true);
    expect(day.actual.items[0].timeEt).toBe('3:15 PM');
  });

  test('items sorted by YouTube time', () => {
    const plan = buildMonthPlan({
      year: 2026,
      month: 6,
      persistedJobs: {},
      youtubeItems: [
        {
          source: 'youtube_studio',
          videoId: 'late',
          title: 'Late',
          publishAt: '2026-06-30T23:00:00.000Z',
          dateKey: '2026-06-30',
          timeEt: '7:00 PM',
          kind: 'short',
          status: 'scheduled',
        },
        {
          source: 'youtube_studio',
          videoId: 'early',
          title: 'Early',
          publishAt: '2026-06-30T17:00:00.000Z',
          dateKey: '2026-06-30',
          timeEt: '1:00 PM',
          kind: 'short',
          status: 'scheduled',
        },
      ],
    });
    const d30 = plan.days.find((d) => d.date === '2026-06-30');
    expect(d30.actual.items[0].timeEt).toBe('1:00 PM');
    expect(d30.actual.items[1].timeEt).toBe('7:00 PM');
  });

  test('buildCalendarRangeReport aggregates range', () => {
    const report = buildCalendarRangeReport({
      startDate: '2026-06-30',
      endDate: '2026-06-30',
      persistedJobs: {
        j1: {
          contentType: 'twitch-short',
          stage: 'publish_scheduled',
          scheduledPublishAt: '2026-06-30T21:00:00.000Z',
          title: 'test',
        },
      },
      youtubeItems: [],
    });
    expect(report.ok).toBe(true);
    expect(report.jobIds).toContain('j1');
    expect(report.planned.short).toBe(3);
    expect(report.jobIds.length).toBeGreaterThan(0);
    expect(report.actual.items[0].timeEt).toBeTruthy();
  });
});

describe('classifyYoutubeItem', () => {
  test('short from kind', () => {
    expect(classifyYoutubeItem({ kind: 'short', title: 'clip #Shorts' }).format).toBe('short');
  });
});
