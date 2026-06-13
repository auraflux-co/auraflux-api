const { buildWeekPlan, buildBroadcastToday } = require('../lib/calendar/master_plan');
const { verifyOwnerPin } = require('../lib/calendar/owner_gate');

describe('content calendar master_plan', () => {
  test('week plan includes production and live dayparts', () => {
    const plan = buildWeekPlan({ persistedJobs: {} });
    expect(plan.ok).toBe(true);
    expect(plan.days.length).toBe(7);
    const today = plan.days.find((d) => d.isToday);
    expect(today.production.some((p) => p.id === 'news_long')).toBe(true);
    expect(today.live.youtubeLive.dayparts.length).toBeGreaterThan(0);
  });

  test('nba long disabled off-season', () => {
    const plan = buildWeekPlan({ persistedJobs: {} });
    const today = plan.days.find((d) => d.isToday);
    const nba = today.production.find((p) => p.id === 'nba_long');
    expect(nba.status).toBe('skipped');
  });

  test('broadcast today returns youtube daypart hint', () => {
    const b = buildBroadcastToday({ persistedJobs: {} });
    expect(b.ok).toBe(true);
    expect(b.twitchTv.window).toMatch(/15:00/);
  });
});

describe('calendar owner_gate', () => {
  const orig = process.env.CALENDAR_OWNER_PIN;
  afterEach(() => { process.env.CALENDAR_OWNER_PIN = orig; });

  test('rejects without pin configured', () => {
    delete process.env.CALENDAR_OWNER_PIN;
    expect(verifyOwnerPin('1234').ok).toBe(false);
  });

  test('accepts matching pin', () => {
    process.env.CALENDAR_OWNER_PIN = 'test-pin';
    expect(verifyOwnerPin('test-pin').ok).toBe(true);
  });
});
