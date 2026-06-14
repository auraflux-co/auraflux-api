const fs = require('fs');
const path = require('path');
const {
  slotTimeToIso,
  scheduleJobToSlot,
  findSlotConfig,
  ASSIGNMENTS_PATH,
} = require('../lib/calendar/slot_jobs');

describe('calendar shorts E2E — 5pm / 6pm / 7pm slots', () => {
  const origAssignments = fs.existsSync(ASSIGNMENTS_PATH)
    ? fs.readFileSync(ASSIGNMENTS_PATH, 'utf8')
    : null;

  afterEach(() => {
    if (origAssignments !== null) fs.writeFileSync(ASSIGNMENTS_PATH, origAssignments);
    else if (fs.existsSync(ASSIGNMENTS_PATH)) fs.unlinkSync(ASSIGNMENTS_PATH);
  });

  const futureDate = () => {
    const d = new Date();
    d.setDate(d.getDate() + 3);
    return d.toISOString().slice(0, 10);
  };

  const SHORT_SLOTS = [
    { slotId: 'twitch_short', time: '17:00', contentType: 'twitch-short', jobId: 'clip_short_twitch_1' },
    { slotId: 'news_short', time: '18:00', contentType: 'news-short', jobId: 'clip_short_news_1' },
    { slotId: 'bonus_short', time: '19:00', contentType: 'alternate', jobId: 'clip_short_bonus_1' },
  ];

  test.each(SHORT_SLOTS)('$slotId at $time ET schedules YT+TikTok+IG', ({ slotId, time, contentType, jobId }) => {
    const slot = findSlotConfig(slotId);
    expect(slot).toBeTruthy();
    expect(slot.time).toBe(time);
    expect(slot.publishPlatforms).toEqual(expect.arrayContaining(['youtube', 'tiktok', 'instagram']));

    const dateKey = futureDate();
    const iso = slotTimeToIso(dateKey, time);
    expect(new Date(iso).getTime()).toBeGreaterThan(Date.now());

    const ct = contentType === 'alternate' ? 'news-short' : contentType;
    const persisted = {
      [jobId]: { contentType: ct, stage: 'assembled', title: `Test ${slotId}` },
    };
    const saved = {};
    const result = scheduleJobToSlot({
      jobId,
      slotId,
      date: dateKey,
      persistedJobs: persisted,
      saveJobCard: (id, card) => { saved[id] = { ...card }; },
    });

    expect(result.ok).toBe(true);
    expect(result.platforms).toEqual(expect.arrayContaining(['youtube', 'tiktok', 'instagram']));
    expect(saved[jobId].stage).toBe('publish_scheduled');
    expect(saved[jobId].scheduledPublishAt).toBe(iso);
    expect(saved[jobId].calendarSlotId).toBe(slotId);
  });
});
